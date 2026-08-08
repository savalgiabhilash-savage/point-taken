# FPL Player Selector — Project Context

## What this is
A personal-first (productizable later) FPL decision tool: pulls FPL + xG + fixtures + odds +
injuries + news, scores players with a transparent, own-built expected-points model, and optimizes
a 15-man squad, transfer path, captain, and chip timing for MY real team. Ships with a
news/sentiment layer and a data-grounded AI assistant.

Current status: **Phase 0–1 (the "first win")** — FPL API → Supabase → live player table.
See `../FPL-Selector-Plan.md` (spec) and the approved build plan for the full roadmap.

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

## Run it
- Worker: `uv run --directory worker python -m fpl_worker.refresh --refresh`
  (dry run: add `--dry-run`; offline from cache: `--dry-run --from-cache`).
- Web: `cd web && npm run dev` → http://localhost:3000/players
