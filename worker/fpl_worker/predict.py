"""Best-XI predictions, accuracy tracking, and model calibration (spec §10 backtest loop).

Each `--run`:
  1. Score any finished-but-unscored gameweeks — fetch actual FPL points and fill in the
     prediction_log (per player) and gw_predictions (the best XI we'd published).
  2. Recompute a per-position calibration multiplier from everything scored so far. It's applied
     by the NEXT model run (a one-cycle lag; calibration moves slowly). Shrunk toward 1.0 by
     sample size so a single noisy gameweek barely moves it — identity until GWs actually complete.
  3. Compute the best XI for the next gameweek two ways — within a £100m budget and with no budget
     (full FPL squad rules either way) — and log both.

    python -m fpl_worker.predict --run
    python -m fpl_worker.predict --dry-run     # compute + print the best XIs, no DB writes

Requires the 0003_predictions.sql tables. Safe to run before they exist — it prints a hint and exits.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone

from dotenv import load_dotenv

from . import db
from .fpl_client import FplClient
from .optimize import BUDGET, _solve, load_pool

UNCAPPED_BUDGET = 100_000   # effectively unlimited (a real 15 costs < £200m = 2000 tenths)
CALIB_SHRINK_K = 3.0        # shrink the multiplier toward 1.0 by this many "virtual" gameweeks
CALIB_MIN_PRED = 2.0        # only calibrate over players the model actually backs (xp >= 2)
CALIB_CLAMP = (0.8, 1.2)    # never let calibration swing a projection more than ±20%
# Earlier logs are unusable for calibration: they were snapshotted weeks before the deadline (players
# who later left scored 0) and projected with the broken current-season minutes model. Calibrate only on
# gameweeks logged after those fixes.
CALIB_FROM_GW = 6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _best_for_gw(pool: list[dict], xp_by_gw: dict, gw: int, budget: int):
    """Best 15 (with a valid XI + captain) for a single gameweek within `budget`."""
    uni = [{**p, "xp5": xp_by_gw.get(p["fpl_id"], {}).get(gw, 0.0),
            "xpn": xp_by_gw.get(p["fpl_id"], {}).get(gw, 0.0)} for p in pool]
    squad = _solve(uni, budget, current_count=0, free_transfers=15)["squad"]
    starters = [p for p in squad if p["is_start"]]
    cap = next((p for p in squad if p["is_captain"]), None)
    predicted = sum(p["xpn"] for p in starters) + (cap["xpn"] if cap else 0.0)
    return squad, round(predicted, 2)


def _slim(p: dict) -> dict:
    return {k: p[k] for k in
            ("fpl_id", "web_name", "position", "team_short", "now_cost", "xpn", "is_start", "is_captain")}


# --- 1. scoring ---------------------------------------------------------------

def score_finished(sb, client: FplClient) -> None:
    finished = {e["id"] for e in client.bootstrap_static().get("events", []) if e.get("finished")}
    if not finished:
        print("  scoring: no finished gameweeks yet")
        return
    # A GW needs scoring if either its per-player log or its published Best XI is still unscored.
    pending = (
        sb.table("prediction_log").select("gw").eq("scored", False)
        .in_("gw", list(finished)).execute().data
    )
    pending_xi = (
        sb.table("gw_predictions").select("gw").eq("scored", False)
        .in_("gw", list(finished)).execute().data
    )
    gws = sorted({r["gw"] for r in pending + pending_xi})
    if not gws:
        print("  scoring: nothing new to score")
        return

    for gw in gws:
        live = client.event_live(gw)
        actual = {e["id"]: (e["stats"]["total_points"], e["stats"]["minutes"])
                  for e in live.get("elements", [])}

        logs = _all(sb, "prediction_log", "gw, player_id", eq=("gw", gw), eq2=("scored", False))
        updates = []
        for r in logs:
            pts, mins = actual.get(r["player_id"], (0, 0))
            updates.append({"gw": gw, "player_id": r["player_id"],
                            "actual_pts": pts, "minutes": mins, "scored": True})
        db.upsert(sb, "prediction_log", updates, on_conflict="gw,player_id")

        preds = sb.table("gw_predictions").select("*").eq("gw", gw).eq("scored", False).execute().data
        for pr in preds:
            starters = [p for p in pr["squad"] if p.get("is_start")]
            cap = next((p for p in pr["squad"] if p.get("is_captain")), None)
            act = sum(actual.get(p["fpl_id"], (0, 0))[0] for p in starters)
            if cap:
                act += actual.get(cap["fpl_id"], (0, 0))[0]  # captain doubles
            sb.table("gw_predictions").update(
                {"actual_pts": act, "scored": True, "scored_at": _now()}
            ).eq("gw", gw).eq("variant", pr["variant"]).execute()
        print(f"  scored GW{gw}: {len(updates)} players, {len(preds)} squad predictions")


# --- 2. calibration -----------------------------------------------------------

def update_calibration(sb) -> None:
    rows = _all(sb, "prediction_log", "position, predicted_xp, actual_pts, gw",
                eq=("scored", True), gte=("predicted_xp", CALIB_MIN_PRED))
    rows = [r for r in rows if r["gw"] >= CALIB_FROM_GW]
    if not rows:
        # Reset to identity so a multiplier learned from unusable data doesn't linger.
        sb.table("model_calibration").update(
            {"n_gws": 0, "sum_pred": 0, "sum_actual": 0, "multiplier": 1.0, "updated_at": _now()}
        ).neq("position", "").execute()
        print(f"  calibration: no scored data from GW{CALIB_FROM_GW} yet — projections uncalibrated (×1.0)")
        return
    agg: dict[str, dict] = defaultdict(lambda: {"pred": 0.0, "actual": 0.0, "gws": set()})
    for r in rows:
        a = agg[r["position"]]
        a["pred"] += r["predicted_xp"] or 0.0
        a["actual"] += r["actual_pts"] or 0.0
        a["gws"].add(r["gw"])
    for pos, a in agg.items():
        if a["pred"] <= 0:
            continue
        raw = max(0.5, min(2.0, a["actual"] / a["pred"]))   # actual/predicted ratio
        n = len(a["gws"])
        mult = (n * raw + CALIB_SHRINK_K) / (n + CALIB_SHRINK_K)  # shrink toward 1.0 by sample size
        mult = max(CALIB_CLAMP[0], min(CALIB_CLAMP[1], mult))
        sb.table("model_calibration").upsert(
            {"position": pos, "n_gws": n, "sum_pred": round(a["pred"], 1),
             "sum_actual": round(a["actual"], 1), "multiplier": round(mult, 3), "updated_at": _now()},
            on_conflict="position",
        ).execute()
        print(f"  calibration {pos}: ×{mult:.3f}  (pred {a['pred']:.0f} vs actual {a['actual']:.0f}, {n} GWs)")


# --- 3. best XI + snapshot ----------------------------------------------------

def log_best_squads(sb, pool, xp_by_gw, gw) -> None:
    # Never reopen a gameweek that has already been scored.
    if sb.table("gw_predictions").select("gw").eq("gw", gw).eq("scored", True).limit(1).execute().data:
        print(f"  best XI GW{gw}: already scored — not overwriting")
        return
    for variant, budget in (("capped", BUDGET), ("uncapped", UNCAPPED_BUDGET)):
        squad, predicted = _best_for_gw(pool, xp_by_gw, gw, budget)
        cost = sum(p["now_cost"] for p in squad) / 10
        sb.table("gw_predictions").upsert(
            {"gw": gw, "variant": variant, "squad": [_slim(p) for p in squad],
             "predicted_pts": predicted, "actual_pts": None, "scored": False, "scored_at": None},
            on_conflict="gw,variant",
        ).execute()
        print(f"  best XI {variant:8} GW{gw}: {predicted} predicted pts, £{cost:.1f}m")


def snapshot_predictions(sb, pool, xp_by_gw, gw) -> None:
    rows = [{"gw": gw, "player_id": p["fpl_id"], "position": p["position"],
             "predicted_xp": round(xp_by_gw[p["fpl_id"]][gw], 3)}
            for p in pool if gw in xp_by_gw.get(p["fpl_id"], {})]
    # Replace the unscored snapshot for this GW rather than upserting over it, so players who have
    # since dropped out of the pool (injured, left the league) don't keep a stale prediction.
    # The GW only changes at the deadline (model uses FPL's is_next), so the last pre-deadline run is
    # the snapshot that gets scored.
    sb.table("prediction_log").delete().eq("gw", gw).eq("scored", False).execute()
    db.upsert(sb, "prediction_log", rows, on_conflict="gw,player_id")
    print(f"  snapshotted {len(rows)} player predictions for GW{gw}")


# --- helpers ------------------------------------------------------------------

def _all(sb, table, cols, eq=None, eq2=None, gte=None) -> list[dict]:
    """Paginated select (PostgREST caps at 1000 rows)."""
    size, out, frm = 1000, [], 0
    while True:
        q = sb.table(table).select(cols)
        if eq:
            q = q.eq(*eq)
        if eq2:
            q = q.eq(*eq2)
        if gte:
            q = q.gte(*gte)
        batch = q.range(frm, frm + size - 1).execute().data
        out.extend(batch)
        if len(batch) < size:
            return out
        frm += size


def _tables_ready(sb) -> bool:
    try:
        sb.table("gw_predictions").select("gw").limit(1).execute()
        return True
    except Exception as exc:  # noqa: BLE001 — any error here means the table isn't there yet
        print(f"predictions tables not found ({exc}). Run supabase/migrations/0003_predictions.sql first.")
        return False


def run(sb, dry_run: bool = False) -> None:
    pool, gws, _, _, _, xp_by_gw = load_pool(sb)
    if not gws:
        print("No projections found — run the model first.")
        return
    next_gw = gws[0]

    if dry_run:
        for variant, budget in (("capped", BUDGET), ("uncapped", UNCAPPED_BUDGET)):
            squad, predicted = _best_for_gw(pool, xp_by_gw, next_gw, budget)
            cost = sum(p["now_cost"] for p in squad) / 10
            cap = next((p for p in squad if p["is_captain"]), None)
            print(f"\n{variant.upper()} best XI — GW{next_gw}: {predicted} predicted pts, "
                  f"£{cost:.1f}m, captain {cap['web_name'] if cap else '?'}")
            order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
            for p in sorted([s for s in squad if s["is_start"]], key=lambda x: (order[x["position"]], -x["xpn"])):
                c = " (C)" if p["is_captain"] else ""
                print(f"  {p['position']:3} {p['web_name'][:16]:17}{p['team_short']:4} £{p['now_cost']/10:<5} xp={p['xpn']}{c}")
        return

    if not _tables_ready(sb):
        return
    with FplClient() as client:
        score_finished(sb, client)
    update_calibration(sb)
    log_best_squads(sb, pool, xp_by_gw, next_gw)
    snapshot_predictions(sb, pool, xp_by_gw, next_gw)


def main() -> None:
    parser = argparse.ArgumentParser(description="Best-XI predictions + accuracy + calibration.")
    parser.add_argument("--run", action="store_true", help="score, calibrate, and log predictions")
    parser.add_argument("--dry-run", action="store_true", help="compute + print best XIs, no DB writes")
    args = parser.parse_args()
    load_dotenv()
    sb = db.get_client()
    run(sb, dry_run=args.dry_run or not args.run)


if __name__ == "__main__":
    main()
