# FPL Player Selector

A personal Fantasy Premier League decision tool: FPL + Understat data → a transparent rules-based xPts
model → a HiGHS MILP optimizer for transfers, captain and chips on your real team, plus news sentiment
and a grounded Claude assistant. Live at https://fpl-selector.vercel.app.

**Full reference:** `web/content/architecture.html` (the "Blueprint": architecture, pipeline, every
formula and parameter, known issues). It is the owner-only Docs tab in the app and a Claude artifact;
keep it updated with every change (see `CLAUDE.md`).

## Stack
- **web/** — Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui + TanStack Table
- **worker/** — Python (managed by `uv`): ETL, xPts model, predictions/calibration, optimizer, team sync, news
- **supabase/** — Postgres schema + RLS (`migrations/0001`–`0007`, run in order in the SQL editor)
- **mobile/** — Expo app (Players + My Team)

## Setup

### 1. Supabase
Create a free project at [supabase.com](https://supabase.com). In **Project Settings → API** copy the
Project URL, `anon` key, and `service_role` key. Apply the schema: open the **SQL Editor**, paste the
contents of `supabase/migrations/0001_init.sql`, and run it.

### 2. Worker (Python ETL)
```bash
cd worker
cp .env.example .env          # then fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
uv sync
uv run python -m fpl_worker.refresh --refresh   # FPL API -> Supabase (teams/players/fixtures)
uv run python -m fpl_worker.enrich --all         # Phase 2: Understat crosswalk + custom FDR
```
- Dry run (no DB write): `uv run python -m fpl_worker.refresh --dry-run`
- Offline from cache: `uv run python -m fpl_worker.refresh --dry-run --from-cache`
- `enrich` writes `players.understat_id`, `fixtures.custom_fdr_*`, and review CSVs to `worker/reports/`.

> **Windows note:** if Smart App Control is enforced, uv's bundled Python can't load pandas
> (blocked DLL). Install official Python (`winget install Python.Python.3.12`), build the venv on
> it (`uv sync --python <that python.exe>`), and run modules via `.venv\Scripts\python.exe`.

### 3. Web
```bash
cd web
cp .env.local.example .env.local   # then fill NEXT_PUBLIC_SUPABASE_URL + _ANON_KEY
npm install
npm run dev                        # http://localhost:3000/players
```

## Scheduled refresh
`.github/workflows/refresh.yml` runs the data pipeline every 2 h (`news.yml` twice a day; `optimize.yml` on
demand from the web app). It activates once the repo is on GitHub with
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set as Actions secrets.

## Notes
- The frontend never calls the FPL API directly (it's CORS-blocked); all fetching is server-side in the worker.
- Secrets live only in gitignored `.env` files. The `service_role` key is server-side only.
