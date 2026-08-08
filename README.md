# FPL Player Selector

A personal Fantasy Premier League decision tool. **Phase 0–1 ("first win"):** pull the official FPL
API into Supabase and browse every player in a live, sortable/filterable table. Full roadmap (own xPts
model, multi-week + chip optimizer, news/sentiment, grounded AI assistant) is in `../FPL-Selector-Plan.md`.

## Stack
- **web/** — Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui + TanStack Table
- **worker/** — Python (managed by `uv`): FPL API → Supabase ETL
- **supabase/** — Postgres schema (`migrations/0001_init.sql`)

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
`.github/workflows/refresh.yml` runs the worker 3×/day. It activates once the repo is on GitHub with
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set as Actions secrets.

## Notes
- The frontend never calls the FPL API directly (it's CORS-blocked); all fetching is server-side in the worker.
- Secrets live only in gitignored `.env` files. The `service_role` key is server-side only.
