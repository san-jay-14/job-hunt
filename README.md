# Job Hunt Pipeline

A personal, single-user tool that pulls fresh intern / fresher / contract job
listings from a handful of sources every morning, filters out likely-fake and
ghost postings, scores what's left against a resume, and sends the top matches
over Telegram. Built to run once a day on Railway's cron scheduler.

See [BUILD_SPEC.md](BUILD_SPEC.md) for the full spec and phased build plan.

## Local development

```bash
npm install
cp .env.example .env   # then fill in real values
npm run dev            # runs src/index.ts via ts-node
```

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run start` — run the compiled pipeline (`dist/index.js`)
- `npm run dev` — run the pipeline from source via ts-node
- `npm run optimize -- <#> [<#> ...]` — tailor your resume to selected jobs (see below)
- `npm run gmail:auth` — one-time Gmail OAuth refresh-token helper (Phase 8, deferred)

## Resume optimizer (`npm run optimize`)

A user-triggered, **local-only** command that tailors your résumé to one or more
selected jobs, compiles it with `pdflatex`, and saves a PDF to `output/`.

Each job in the Telegram digest is labelled with a short `#id` (e.g. `#42`). Pass
those ids to optimize one or several at once:

```bash
npm run optimize -- 42          # tailor for job #42
npm run optimize -- 42 43 51    # tailor for several jobs at once
```

For each job it: tailors `resume.tex` to the posting with a powerful model
(truthfully reordering/rephrasing existing content — **it never invents**
experience, skills, or dates), compiles with `pdflatex` (retrying with the
model's help if LaTeX errors occur), and writes
`output/<Company>_<Role>.pdf` (plus the tailored `.tex`).

**Prerequisites (local):**

1. **`resume.tex`** at the repo root — your résumé as a LaTeX file. It's
   gitignored (kept off the public remote), same as `resume.txt`.
2. **A LaTeX toolchain** so `pdflatex` is on your `PATH` — on Windows,
   [MiKTeX](https://miktex.org/download) is the easiest; TeX Live also works.
   Verify with `pdflatex --version`.

The optimizer needs `ANTHROPIC_API_KEY` and a running database (the same
`DATABASE_URL` the pipeline uses), since it reads the stored job by its `#id`.

## Deployment (Railway, daily cron)

The pipeline is a run-once-and-exit job. Railway's cron scheduler starts the
container, runs it, and it exits — [`railway.json`](railway.json) declares the
schedule (`30 1 * * *` = 01:30 UTC / 07:00 IST; change to your wake time). The
`optimize` command and `pdflatex` are **not** part of deployment — they're local.

Repo-side config is already in place: `railway.json`, a `postinstall` that runs
`prisma generate`, Node pinned to `>=20`, and a start command that applies
migrations before each run:

```
npx prisma migrate deploy && npm run build && npm run start
```

**One-time setup on Railway** (needs your account — done in the Railway CLI /
dashboard):

1. `npm i -g @railway/cli && railway login`
2. `railway init` in the repo root.
3. Add a Postgres plugin (`railway add` or the dashboard). Railway sets
   `DATABASE_URL` automatically.
4. In the service **Variables** tab, set every var from `.env.example` except
   `DATABASE_URL`: `ANTHROPIC_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`,
   `ADZUNA_COUNTRY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SEARCH_KEYWORDS`,
   `SEARCH_LOCATION`, and **`RESUME_TEXT`** (paste your `resume.txt` contents —
   the file is gitignored, so the container needs the résumé via this var, or
   scoring is skipped).
5. `railway up` to deploy (or connect the GitHub repo for auto-deploy on push).

**Verify:** trigger a manual run from the dashboard (or set a near-future
`cronSchedule` temporarily). A run is healthy when a real digest lands in
Telegram and the deployed Postgres has a `RunLog` row with `status = "success"`.
