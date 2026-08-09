# The Brain Behind the Recommendations

*How every number and suggestion in this app is produced — end to end, with the exact parameters used.*

The guiding principle (from the project spec) is **transparency**: every projected-points number
is the sum of named components, and nothing is ever invented. The assistant and the optimizer may
only use numbers the model actually produced. This document walks the whole chain:

```
FPL + Understat data  →  xPts model  →  accuracy scoring + self-calibration  →  optimizer (transfers + chips)  →  the app
        (refresh)         (model.py)          (predict.py)                        (optimize.py)                    (web)
```

Everything runs on a schedule (GitHub Actions, every 3 hours) with no laptop involved.

---

## 1. What goes in — the data foundation

| Source | What it gives | Where |
|---|---|---|
| **FPL API** (`bootstrap-static`, `fixtures`) | players, teams, prices, ownership %, availability status, chance-of-playing, last-season minutes, form, fixtures | `refresh.py` → `players`, `teams`, `fixtures` |
| **Understat** (via `soccerdata`) | last-season **xG / xA per player** and **team xG for/against per game** | `soccer_stats.py`, `fdr.py` |
| **Custom FDR** | a data-driven 1–5 fixture difficulty from team xG-difference | `fdr.py` → `fixtures.custom_fdr_h/a` |
| **News/sentiment** (Claude Haiku 4.5) | `minutes_risk_adj` + advisory sentiment on flagged/owned players | `news.py`, `sentiment.py` → `news_sentiment` |

**Custom Fixture Difficulty (`fdr.py`).** FPL's own preseason team strengths are all zero, so
difficulty is derived from last season's Understat xG instead. Each team's rating = (xG-for −
xG-against) per game. A fixture's difficulty for a team scales with the **opponent's** rating,
normalised across the league to a 1–5 scale, with a home-advantage nudge of **0.25** (home a touch
easier, away a touch harder). Promoted clubs with no last-season PL data inherit the weakest
returning team's rating.

---

## 2. The xPts model — the core brain (`model.py`, `model_version = "rules-v1"`)

Every player, every gameweek, gets an expected-points number that is the **sum of eight named
components**. Here is exactly how each is built.

### 2.1 Minutes first (nothing scores if you don't play)

All attacking output scales by expected minutes. From `_minutes()`:

- **Availability** from status: injured/suspended/unavailable (`i/s/u/n`) → `0.0`; else
  `chance_of_playing / 100`; `d` (doubtful) with no % → `0.5`; otherwise `1.0`.
- **Nailed-on prior** = `min(1, last_season_minutes / 2600)` (2600 ≈ 29 full games).
- `p_start = availability × nailed`
- `p_cameo = (1 − p_start) × 0.15` (only if available) — a sub appearance.
- `exp_minutes = p_start × 82 + p_cameo × 20`
- `p_60 = p_start × 0.9` (probability of the 60-min appearance point / clean-sheet eligibility).

### 2.2 Attacking returns — empirical-Bayes shrinkage

A player's raw last-season per-90 xG/xA is **shrunk toward the positional average** so a small
sample or a hot streak regresses sensibly (`player_rates()`):

```
blended_per90 = (observed_per90 + K · position_base_per90) / (n90 + K),   K = PRIOR_K = 12
```

`K = 12` means ~12 "phantom" 90-minute matches at the position average are mixed in — a third of a
season of regression. Players with no matched PL data stay at 0 (no invented output).

Then per fixture:

- `x_goals   = xg90 × (exp_minutes / 90) × fixture_adj`
- `x_assists = xa90 × (exp_minutes / 90) × fixture_adj`
- `x_goals_pts   = x_goals   × GOAL_PTS[pos]` — **GK/DEF = 6, MID = 5, FWD = 4**
- `x_assist_pts  = x_assists × 3`

**Fixture adjustment** (`_attack_adj`): `1 + 0.12 × (3 − FDR)`, so an easy fixture (FDR 1) ≈ **×1.24**
and a hard one (FDR 5) ≈ **×0.76**.

### 2.3 Clean sheets — a Poisson model

Expected goals conceded blends the opponent's attack and our defence, with a home/away tweak:

```
λ = 0.5 · opponent_xGF_pg + 0.5 · our_xGA_pg,   then × 0.9 (home) or × 1.1 (away)
P(clean sheet) = exp(−λ)
x_cs_pts = P(CS) × CS_PTS[pos] × p_60          CS_PTS: GK/DEF = 4, MID = 1, FWD = 0
```

### 2.4 The remaining components

| Component | Formula | Notes |
|---|---|---|
| **Appearance** | `p_play × 1 + p_60 × 1` | the 1 pt for playing + 1 pt for 60 mins |
| **Saves** (GK) | `(λ × 2/3) × p_start` | rough: more expected shots faced → more saves |
| **DefCon** | `DEFCON_BASE[pos] × mins_frac × 2` | *placeholder* until FBref tackle/interception data (DEF 0.45, MID 0.15, GK 0.05, FWD 0.03) |
| **Bonus** | `min(1.5, 0.25 × involvement)` | proxy from goal+assist(+CS for GK/DEF) involvement |
| **Deductions** | `−(λ/2)×p_start` (GK/DEF goals conceded) + `−(yellow90 × mins_frac)` | cards + goals-conceded penalty |

The headline is `x_pts = appearance + goals + assists + CS + saves + defcon + bonus + deductions`,
and **every one of these is stored** so the UI can explain the number.

### 2.5 Double & Blank gameweeks are built in

When a team plays **twice** in a gameweek, the model runs `project_fixture` for **both** legs and
**sums** them (so a DGW player's xPts is naturally ~2×). When a team has **no** fixture (a blank),
there is simply no projection row for that GW. This means the whole downstream chain — best XI,
transfers, chip timing — reacts to DGWs/BGWs automatically, without special-casing.

---

## 3. How the model learns — accuracy tracking & self-calibration (`predict.py`)

Each scheduled run:

1. **Scores** any finished-but-unscored gameweeks — fetches **actual** FPL points per player
   (`event/{gw}/live`) and fills `prediction_log` and the published best-XI `gw_predictions`.
2. **Recomputes a per-position calibration multiplier** from everything scored so far:

   ```
   raw   = clamp(actual_total / predicted_total, 0.5, 2.0)          # per position
   mult  = (n_gws · raw + K) / (n_gws + K),   K = CALIB_SHRINK_K = 3 # shrink toward 1.0
   mult  = clamp(mult, 0.8, 1.2)                                     # never swing a proj > ±20%
   ```

   Only players the model actually backs (`predicted_xp ≥ 2`) count, so noise from fringe players
   doesn't move it. It is applied by the **next** model run (a deliberate one-cycle lag; calibration
   moves slowly). **Until real gameweeks complete, every multiplier is ×1.0** — the model does not
   pretend to be calibrated before it has evidence.

3. **Logs the best XI two ways** — within a **£100m** budget (`capped`) and with **no budget**
   (`uncapped`) — and tracks how close each prediction lands. This is the "how accurate was the
   model this week" scorecard in the Best XI tab.

---

## 4. From points to decisions — the optimizer (`optimize.py`, HiGHS MILP)

The optimizer is a **mixed-integer linear program** solved by HiGHS. It never "picks favourites" —
it maximises expected points under the real FPL rules.

### 4.1 Hard constraints (always respected)

- Exactly **15** players; squad quota **2 GK / 5 DEF / 5 MID / 3 FWD**.
- **≤ 3 players per club**.
- **Budget** = squad value + bank (£100m for a fresh build).
- A valid **XI of 11** with a legal formation (GK 1; DEF 3–5; MID 2–5; FWD 1–3).
- Exactly **1 captain**, who must be a starter.

### 4.2 Objective (what it maximises)

```
maximise   Σ xPts(starters)  +  xPts(captain)      # captain counts twice
                              +  0.1 · Σ xPts(bench)   # bench weighted low but non-zero
                              −  4 · (paid transfers)  # each hit beyond free transfers costs 4
```

`BENCH_WEIGHT = 0.1`, `HIT_COST = 4`. The captain term is why the captain is always the
**highest next-GW xPts** eligible starter.

### 4.3 The multi-week transfer path (`_solve_path`)

This is the part that makes suggestions feel "planned". Instead of optimising one deadline, it
solves a **single joint MILP across the whole 5-GW horizon**, choosing the squad, XI, captain and
transfers for **every** gameweek at once. That lets the solver decide:

- **when** to make each transfer,
- **when to roll** a free transfer (they accumulate, cap **`FT_CAP = 5`**),
- **when a −4 hit actually pays off** over the horizon.

Future gameweeks are discounted by **`DECAY = 0.9` per GW** (uncertainty grows with distance), and
the candidate pool is bounded to your squad + the top-90 others by horizon xPts (`POOL_SIZE = 90`)
to keep it tractable. The headline **"+X xPts over N GWs vs holding"** compares the planned path to
simply keeping your current squad and captaining optimally each week.

Transfer suggestions are shown **like-for-like by position** (a DEF out ⇒ a DEF in), because the
squad always keeps its 2/5/5/3 shape.

---

## 5. Chip timing — marginal value, and now DGW/BGW-aware

The key idea (and the fix for the old nonsense "Wildcard in GW1"): **a chip is valued as its
marginal gain over playing normally along your planned transfer path** — not versus a frozen
"do-nothing" squad. Preseason your normal transfers are already free/unlimited, so a Wildcard adds
≈0 and is correctly **not** recommended.

| Chip | Valued as | Threshold to recommend |
|---|---|---|
| **Triple Captain** | the captain's points again (the extra ×1 a TC adds) | **12.0** |
| **Bench Boost** | your 4 bench players' total that GW | **18.0** |
| **Wildcard** | (free full rebuild − planned path over the window) **+ hits saved** | **8.0** |
| **Free Hit** | (one-week optimal squad − the team you'd actually field) | **8.0** |

A chip is only recommended if its marginal gain **clears its own bar**; otherwise the honest default
is **"hold your chips."** The bars are set so an ordinary single gameweek never fires a chip.

**DGW/BGW awareness (`_gw_flags`).** The optimizer now counts fixtures per club per gameweek and
labels each GW: **DGW** (some clubs play twice) or **BGW** (some clubs have no fixture). Because a
DGW doubles the relevant projections, Bench Boost and Triple Captain gains spike there, and Free Hit
gains spike in a BGW — so the argmax lands on the right week automatically, and the recommendation
now **says why** ("GW34 is a Double GW — 6 clubs play twice"). Preseason the schedule is all single
fixtures, so nothing is flagged and the advice reads "best saved for a Double/Blank GW." The flags
light up once the season's doubles/blanks are announced (fixtures move for cup ties). A **DGW/BGW
badge** appears on each chip window in the Optimizer tab.

---

## 6. The assistant — grounded, cites numbers, never invents (`web/app/api/assistant`)

Claude **Haiku 4.5** with tool-calling over Supabase. It has five read-only tools
(`list_top_players`, `get_player`, `get_my_team`, `get_optimizer_plan`, `get_best_xi`) and a strict
system prompt: it may only cite numbers those tools return, and it routes "what should I do"
questions through the optimizer plan. It is a **spokesperson for the model**, not an independent
opinion.

---

## 7. Every parameter in one place

| Parameter | Value | Meaning |
|---|---|---|
| `GOAL_PTS` | GK/DEF 6, MID 5, FWD 4 | points per expected goal by position |
| `ASSIST_PTS` | 3 | points per expected assist |
| `CS_PTS` | GK/DEF 4, MID 1, FWD 0 | clean-sheet points by position |
| `PRIOR_K` | 12 | attacking-rate shrinkage strength (in 90s) |
| nailed-on divisor | 2600 mins | last-season minutes → starter prior |
| cameo prob / mins | 0.15 / 20 | sub-appearance likelihood and minutes |
| starter minutes | 82 | expected minutes for a starter |
| fixture adj slope | 0.12 per FDR step | easy ≈ ×1.24, hard ≈ ×0.76 |
| CS home/away | ×0.9 / ×1.1 | goals-conceded tweak |
| bonus cap | 1.5 | max bonus proxy |
| `HOME_ADVANTAGE` (FDR) | 0.25 | home fixtures a touch easier |
| `CALIB_SHRINK_K` | 3 | calibration shrink toward ×1.0 |
| `CALIB_MIN_PRED` | 2.0 | only calibrate on backed players |
| `CALIB_CLAMP` | 0.8–1.2 | max ±20% calibration swing |
| `BUDGET` | £100.0m | squad budget |
| `SQUAD_QUOTA` | 2/5/5/3 | GK/DEF/MID/FWD |
| `≤ per club` | 3 | club limit |
| `BENCH_WEIGHT` | 0.1 | bench weight in the objective |
| `HIT_COST` | 4 | points per extra transfer |
| `FT_CAP` | 5 | free-transfer accumulation cap |
| `DECAY` | 0.9 / GW | future-gameweek discount |
| `POOL_SIZE` | 90 | candidate players beyond your squad |
| chip thresholds | TC 12 · BB 18 · WC 8 · FH 8 | marginal gain needed to recommend |

---

## 8. Honest limitations (so you can trust it appropriately)

- **Preseason priors.** With no 2026/27 matches yet, attacking output uses **last-season** Understat
  xG and minutes. It sharpens as the season provides live data and calibration kicks in.
- **Placeholders.** DefCon and bonus are rough proxies until FBref tackle/interception data is wired
  in. Sentiment is **advisory** (it nudges minutes risk) and stays that way until backtested.
- **Selling price** is approximated by current price (exact preseason; slightly off once prices move).
- **Calibration is ×1.0** until real gameweeks complete — the model won't overclaim accuracy early.
- **DGW/BGW flags** are dormant preseason (the schedule has no doubles/blanks yet).

---

## 9. Why you can trust each number

Every headline xPts is a **sum of stored components**, every projection carries its `model_version`,
the optimizer only ever maximises those points under the real rules, chip advice is a **marginal**
calculation with a visible bar, and the assistant can only repeat numbers the model produced. When
the model is wrong, the calibration loop measures **how** wrong (per position) and corrects the next
run — transparently, and on the record in the Best XI tab.
