"""Weekly re-tune of the backtestable factor strengths (runs from .github/workflows/retune.yml).

Replays last season plus this season's completed gameweeks (the FPL dataset publishes the current season
as it goes), tries a few values for each strength, and keeps a new value only if it lowers RMSE by at
least MIN_GAIN — so ordinary noise can't churn the model. Winners are written to model_params, which the
live model reads on its next run. The live-only factors (news, penalties, set pieces, return from
injury, predicted line-ups) are re-learned separately every run by predict.py.

    python -m fpl_worker.tune --run
    python -m fpl_worker.tune --dry-run     # print the scorecard and proposals, no DB write
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone

import pandas as pd
from dotenv import load_dotenv

from . import backtest, context_model, db, form_model, fpl_history

MIN_GAIN = 0.002
GRID = {
    "congestion": ("context_model", "CONGESTION", [0.0, 0.04, 0.08, 0.12]),
    "last_season_weight": ("form_model", "LAST_SEASON_WEIGHT", [0.5, 0.75, 1.0]),
    "share_k": ("form_model", "SHARE_K", [1.0, 2.0, 4.0]),
}
MODULES = {"context_model": context_model, "form_model": form_model}


def apply_params(params: dict[str, float]) -> None:
    """Load tuned strengths into the model modules (the live model calls this with model_params)."""
    for key, (mod, attr, _) in GRID.items():
        if key in params:
            setattr(MODULES[mod], attr, params[key])


def _seasons() -> list[str]:
    now = datetime.now(timezone.utc)
    current = fpl_history.season_of(now.year if now.month >= 7 else now.year - 1)
    return [fpl_history.prev_season(current), current]


def _rmse(seasons: list[str]) -> tuple[float, dict]:
    frames = []
    for s in seasons:
        try:
            frames.append(backtest.run_season(s))
        except Exception as exc:  # noqa: BLE001 — current season may not be published yet
            print(f"  {s}: skipped ({exc.__class__.__name__})")
    sc = backtest.score(pd.concat(frames, ignore_index=True))["model"]
    return sc["all"]["rmse"], sc


def run(sb, dry_run: bool = False) -> None:
    seasons = _seasons()
    try:
        current = {r["key"]: float(r["value"]) for r in sb.table("model_params").select("key, value").execute().data}
    except Exception:  # noqa: BLE001
        current = {}
    apply_params(current)
    best, sc = _rmse(seasons)
    print(f"Seasons {seasons}: RMSE {best}, top-20 {sc['top20_avg_pts']}, rank {sc['spearman']}")
    chosen = {}
    for key, (mod, attr, values) in GRID.items():
        keep = getattr(MODULES[mod], attr)
        for v in values:
            if v == keep:
                continue
            setattr(MODULES[mod], attr, v)
            r, _ = _rmse(seasons)
            print(f"  {key}={v}: RMSE {r}")
            if r <= best - MIN_GAIN:
                best, keep = r, v
        setattr(MODULES[mod], attr, keep)
        chosen[key] = keep
    print(f"Chosen: {chosen} (RMSE {best})")
    if dry_run:
        return
    stamp = datetime.now(timezone.utc).isoformat()
    for key, value in chosen.items():
        sb.table("model_params").upsert({"key": key, "value": value, "updated_at": stamp,
                                         "note": f"weekly re-tune on {', '.join(seasons)}; RMSE {best}"},
                                        on_conflict="key").execute()


def main() -> None:
    parser = argparse.ArgumentParser(description="Weekly re-tune of factor strengths.")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    load_dotenv()
    run(db.get_client(), dry_run=args.dry_run or not args.run)


if __name__ == "__main__":
    main()
