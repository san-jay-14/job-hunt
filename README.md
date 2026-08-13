# Job Hunt Pipeline

A personal, single-user tool that pulls fresh intern / fresher / contract job
listings from a handful of sources every morning, filters out likely-fake and
ghost postings, scores what's left against a resume, and sends the top matches
over Telegram. Built to run once a day on Railway's cron scheduler.

See [BUILD_SPEC.md](BUILD_SPEC.md) for the full spec and phased build plan.

## Status

Phase 0 — repo and environment setup.

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
- `npm run gmail:auth` — one-time Gmail OAuth refresh-token helper (Phase 8)
