# FPL Player Selector — Project Context

## What this is
A personal-first (productizable later) FPL decision tool: pulls FPL + xG + fixtures + odds +
injuries + news, scores players with a transparent, own-built expected-points model, and optimizes
a 15-man squad, transfer path, captain, and chip timing for MY real team. Ships with a
news/sentiment layer and a data-grounded AI assistant.

Current status: **Phases 0–9 complete and deployed** on Vercel. Data pipeline (FPL + Understat →
Supabase), transparent rules-based xPts model with empirical-Bayes calibration, custom FDR, full
HiGHS MILP optimizer (multi-week transfer path + fixture-aware chip timing, user-selectable horizon),
best-XI predictions + accuracy tracking, Google-News/Claude sentiment, a grounded Claude assistant,
and multi-user auth (Supabase Auth + RLS) with screenshot team import and on-demand re-optimize.
Refreshed every 2h by GitHub Actions. See `../FPL-Selector-Plan.md` for the original spec/roadmap.

## Architecture
- Frontend: **Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui**, on Vercel (`web/`).
  NOTE: this is Next.js 16 / React 19 — conventions differ from older versions; check
  `web/node_modules/next/dist/docs/` before writing framework code.
- Data store: **Supabase** (Postgres + Auth + RLS). Schema in `supabase/migrations/`.
- Model/ETL + optimizer: **Python** (`worker/`, managed by `uv`) — `httpx`, `supabase`, later
  `soccerdata`/`pandas`/`highspy`. Runs as a CLI + GitHub Actions cron. The frontend NEVER calls
  the FPL API directly (it is CORS-blocked).
- LLM: Claude API for news-sentiment classification + a data-grounded assistant (later phases).
- All services on free tiers.

## Non-negotiable principles
- Transparency: every xPts number must be explainable by its components in the UI.
- Minutes first: all xPts scale by P(start) × expected minutes.
- Fixture-adjust all underlying stats; recency-weight but blend with base rates + odds.
- Personalization: always reason about MY team state (bank, free transfers, chips, rank).
- Sentiment is advisory until backtested; always cite news sources.
- Own model: build rules-based first (transparent), add ML only after it's validated.

## Data sources (all free)
FPL API (bootstrap-static, fixtures, element-summary, entry, event/live) · soccerdata
(Understat/FBref) · The Odds API (free tier) · PhysioRoom · olbauday + vaastav datasets.

## Conventions
- TypeScript strict; shadcn/ui; TanStack Table for grids; Recharts for charts.
- Python: type hints, `uv` for env/deps. Store model_version on every projection.
- Explain modeling code in comments (owner is learning the model).
- Never hardcode secrets; use env vars (`worker/.env`, `web/.env.local` — both gitignored).
  Service-role key is server-side only. Enable RLS before any multi-user work.

## Blueprint doc (keep current — required)
`web/content/architecture.html` documents the whole app (architecture, pipeline, xPts model, optimizer,
chips, parameters, known issues, history). It is served at `/docs` (owner-only:
savalgiabhilash@gmail.com, gate in `web/lib/current-user.ts`) and published as the Claude artifact
https://claude.ai/artifact/MrVLaHc9qV1Ck19fXY58EA.
- Any change to behaviour in `worker/`, `web/`, `mobile/`, `supabase/` or `.github/workflows/` must update
  the affected sections in the same commit (formulas, parameters, steps, tables, routes, known issues).
- Bump "doc rev" + date in its header and add a History entry.
- Then republish: Artifact tool, publish that file with `url` = the artifact URL above.

## Run it
- Worker: `uv run --directory worker python -m fpl_worker.refresh --refresh`
  (dry run: add `--dry-run`; offline from cache: `--dry-run --from-cache`).
- Web: `cd web && npm run dev` → http://localhost:3000/players
- Backtest: `uv run --directory worker python -m fpl_worker.backtest` (~10 min; replays 2023/24–2025/26,
  reports to `worker/reports/`). Any change to model.py / fdr.py must be backtested before shipping and
  must beat the baseline in the blueprint (section 17); update that table when a change ships.
