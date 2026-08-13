# Job Hunt Pipeline — Build Spec

## 0. What this is

A personal, single-user tool that pulls fresh intern / fresher / contract job listings
from a handful of sources every morning, filters out likely-fake and ghost postings,
scores what's left against my resume, and sends the top matches to me on Telegram.

This doc is written for Claude Code to build against, top to bottom. Each phase has
a goal, concrete steps, files touched, and a "done when" check. Build and verify one
phase before starting the next — commit after each phase passes its check. Don't
jump ahead to a later phase's code while an earlier phase is unverified.

**Owner / user:** single person, personal use only. No multi-tenancy, no auth system,
no public-facing anything. Optimize for "works reliably every morning," not for scale.

## 1. Explicit scope

**In scope for v1:**
- Adzuna API (covers Indeed + others, India-scoped)
- Wellfound (light scrape)
- LinkedIn Jobs, via saved-search email alerts parsed from Gmail
- Rule-based + LLM fake/ghost-job filtering
- LLM fit scoring against a resume
- Telegram delivery, once daily
- Deployed on Railway, running on a daily cron schedule

**Explicitly out of scope for v1 — do not build these unless asked:**
- Naukri (needs proxy rotation + headless browser; add later as its own connector)
- X / Twitter monitoring (paid API now, handled manually for now)
- LinkedIn hiring-post scraping (handled manually, outside this codebase — do not
  build anything that logs into a personal LinkedIn account and scrapes the feed)
- Any dashboard or frontend — Telegram is the only delivery surface
- Any company-registration (MCA) verification lookup
- Multi-user support of any kind

## 2. Tech stack (locked decisions — do not substitute)

- **Language/runtime:** TypeScript on Node.js 20+
- **Package manager:** npm
- **This is a script, not a server.** No Express, no HTTP listener. The whole thing
  is a CLI entrypoint that runs once, does its work, and exits. Railway's cron
  scheduler starts the container, runs it, and expects it to exit — that's the
  deployment model, not a long-running process with a scheduler inside it.
- **Database:** PostgreSQL via Railway's Postgres plugin
- **ORM:** Prisma
- **HTTP calls:** native `fetch` (built into Node 20+, no axios needed)
- **HTML scraping:** `cheerio`
- **Gmail access:** `googleapis` (OAuth2 with a long-lived refresh token)
- **LLM calls:** `@anthropic-ai/sdk`
- **Fuzzy string matching (for dedupe):** `string-similarity`
- **Hosting/scheduling:** Railway, using `deploy.cronSchedule` in `railway.json`
  (not `node-cron` inside a long-running service — that keeps a container alive
  24/7 for 30 seconds of daily work, which is both more expensive and more
  fragile than letting Railway's own scheduler start and stop the container)

## 3. Repo structure (target shape)

```
job-hunt-pipeline/
├── src/
│   ├── connectors/
│   │   ├── adzuna.ts
│   │   ├── wellfound.ts
│   │   └── linkedinGmail.ts
│   ├── pipeline/
│   │   ├── normalize.ts
│   │   ├── dedupe.ts
│   │   ├── classify.ts
│   │   └── deliver.ts
│   ├── lib/
│   │   ├── db.ts
│   │   ├── anthropic.ts
│   │   └── telegram.ts
│   ├── types.ts
│   └── index.ts
├── prisma/
│   └── schema.prisma
├── scripts/
│   └── getGmailRefreshToken.ts
├── resume.txt
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── railway.json
└── README.md
```

---

## Phase 0 — Repo and environment setup

**Goal:** a TypeScript project that runs locally and connects to a local/dev Postgres.

**Steps:**
1. `git init`, create the folder structure above.
2. `npm init -y`, then install:
   - `typescript ts-node @types/node dotenv` (dev + runtime basics)
   - `@prisma/client prisma`
   - `@anthropic-ai/sdk`
   - `cheerio`
   - `googleapis`
   - `string-similarity @types/string-similarity`
3. `tsconfig.json`: target ES2022, module NodeNext, strict mode on.
4. `.gitignore`: `node_modules`, `.env`, `dist`, `*.log`.
5. `.env.example` listing every variable from section 4 below, with no real values.
6. `package.json` scripts:
   - `"build": "tsc"`
   - `"start": "node dist/index.js"`
   - `"dev": "ts-node src/index.ts"`
   - `"gmail:auth": "ts-node scripts/getGmailRefreshToken.ts"`

**Done when:** `npm run dev` executes `src/index.ts` (even if it just logs
`"pipeline starting"` and exits) with no errors.

## 4. Environment variables (full list, used across later phases)

```
DATABASE_URL=
ANTHROPIC_API_KEY=
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
ADZUNA_COUNTRY=in
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SEARCH_KEYWORDS=frontend intern,react developer intern,SDE intern,fresher software engineer
SEARCH_LOCATION=India
```

---

## Phase 1 — Database schema

**Goal:** Prisma schema that models a Job and a RunLog, migrated to a real Postgres.

**File:** `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Job {
  id          String    @id @default(cuid())
  source      String    // "adzuna" | "wellfound" | "linkedin"
  sourceId    String?
  title       String
  company     String
  location    String
  workType    String?   // "remote" | "onsite" | "hybrid" | null if unknown
  roleType    String?   // "intern" | "fresher" | "contract" | "fulltime"
  description String
  applyUrl    String
  postedAt    DateTime?
  dedupeKey   String    @unique
  fitScore    Int?
  fitReason   String?
  verified    Boolean   @default(false)
  redFlags    String[]  @default([])
  delivered   Boolean   @default(false)
  createdAt   DateTime  @default(now())

  @@index([fitScore])
  @@index([createdAt])
}

model RunLog {
  id         String    @id @default(cuid())
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  status     String    // "success" | "partial" | "failed"
  jobsFound  Int       @default(0)
  jobsNew    Int       @default(0)
  errors     String[]  @default([])
}
```

**Steps:**
1. Set up a local Postgres (Docker is fine for dev) or use a free Railway Postgres
   instance early, pointed at from `.env`.
2. `npx prisma migrate dev --name init`.
3. `src/lib/db.ts` exports a singleton `PrismaClient`.

**Done when:** `npx prisma studio` opens and shows empty `Job` and `RunLog` tables.

---

## Phase 2 — Adzuna connector (build this source first — simplest, no auth flow)

**Goal:** a function that hits the Adzuna API and returns a list of raw listings.

**File:** `src/connectors/adzuna.ts`

**Behavior:**
- Register a free Adzuna developer account manually (outside this codebase) to get
  `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
- Endpoint shape: `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`
  with `app_id`, `app_key`, `what` (keyword), `where` (location) as query params.
- Loop over `SEARCH_KEYWORDS` (comma-split), one request per keyword, page 1 only
  for v1 — free tier is ~33 calls/day, so don't paginate deep.
- Map each result to the raw shape: `{ source: "adzuna", sourceId, title, company,
  location, description, applyUrl, postedAt }`. Leave `workType`/`roleType` unset
  here — that gets filled in during normalization (Phase 3).
- Wrap the whole thing in try/catch per keyword so one failing keyword doesn't
  kill the rest of the run.

**Done when:** running this connector standalone against real keywords returns an
array of raw job objects, logged to console.

---

## Phase 3 — Normalize + dedupe

**Goal:** turn raw, source-specific objects into one consistent shape, and drop
duplicates of the same job appearing from more than one source.

**Files:** `src/pipeline/normalize.ts`, `src/pipeline/dedupe.ts`, `src/types.ts`

**`types.ts`:** define a `NormalizedJob` type matching the Prisma `Job` model
minus DB-generated fields.

**`normalize.ts`:**
- Lowercase and trim `company`, `title`, `location`.
- Infer `workType` from the location/description text: if it contains "remote" →
  `"remote"`, else default `"onsite"`.
- Infer `roleType` from the title: match against a keyword list (`intern`,
  `internship` → `"intern"`; `fresher`, `entry level`, `0-1 year` → `"fresher"`;
  `contract`, `freelance` → `"contract"`; else `"fulltime"`).
- Build `dedupeKey` as a hash (e.g. `crypto.createHash('sha1')`) of
  `normalizedCompany|normalizedTitle|normalizedLocation`.

**`dedupe.ts`:**
- Before inserting, check for an existing `Job` with the same `dedupeKey` — exact
  match, skip.
- For near-duplicates (same company, slightly different title wording across
  sources), use `string-similarity` to compare titles within the same company +
  location; treat anything above a 0.85 similarity score as a duplicate too, and
  skip inserting it.

**Done when:** running Adzuna's raw output through `normalize` then `dedupe`
against a seeded test DB correctly skips a manually-inserted duplicate row.

---

## Phase 4 — Telegram delivery (build early, before scoring exists)

**Goal:** be able to send a formatted message to yourself on Telegram. Build this
now, even with dummy data — having delivery working early means every later
phase can be tested end-to-end immediately.

**File:** `src/lib/telegram.ts`

**Setup (manual, outside this codebase):**
1. Message `@BotFather` on Telegram, `/newbot`, follow the prompts — get a bot
   token.
2. Send any message to your new bot, then hit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to find your own
   numeric `chat_id`.
3. Put both into `.env` as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

**Behavior:**
- One function `sendDigest(jobs: Job[])` that formats a message: job title,
  company, location, fit score (once it exists), and apply link, one job per
  block, newest/highest-scored first.
- POST to `https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`,
  `text`, `parse_mode: "Markdown"`.
- Telegram messages cap around 4096 characters — if the digest is longer, split
  into multiple sequential messages rather than truncating silently.

**Done when:** calling `sendDigest` with 2-3 hardcoded fake job objects produces
a real message in your Telegram chat.

---

## Phase 5 — Orchestrator (this phase = your first real MVP)

**Goal:** one script that runs the full loop: collect → normalize → dedupe →
store → deliver, using only Adzuna as the source for now.

**File:** `src/index.ts`

**Behavior:**
1. Create a `RunLog` row at start.
2. Call the Adzuna connector, catch and log any failure without crashing the run.
3. Normalize + dedupe results, insert new ones into `Job`.
4. Query all `Job` rows from today that aren't yet `delivered`.
5. Call `sendDigest` with them.
6. Mark those rows `delivered: true`.
7. Update the `RunLog` row with final counts and status.

**Done when:** running `npm run dev` end-to-end pulls real Adzuna listings and a
real digest shows up in Telegram, with no scoring yet (just raw listings). This
is the milestone worth treating as "the tool works" — everything after this is
refinement, not a blocker to using it daily.

---

## Phase 6 — Classification: fit score + fake-job flags

**Goal:** before spending an LLM call on every job, run cheap rule-based checks
first, then send survivors to Claude for scoring.

**File:** `src/pipeline/classify.ts`, `src/lib/anthropic.ts`

**Step A — rule-based pre-filter (no LLM cost):**
Flag a job (don't necessarily drop it, just tag it) if the description contains
any of: `"registration fee"`, `"training fee"`, `"security deposit"`, `"laptop
fee"`, `"refundable deposit"`, `"whatsapp only"`, `"telegram only"`. Store hits
in `redFlags`.

**Step B — LLM scoring (one call per job that passes Step A):**
- Load resume content from `resume.txt` (plain text, kept in the repo, not
  committed with personal details if this repo is ever made public — see
  `.gitignore` note in Phase 0 if that becomes relevant).
- Prompt Claude with the job description + resume text, instructing it to return
  **only** JSON matching:
  ```json
  {
    "fitScore": 0-100,
    "fitReason": "one sentence",
    "verified": true | false,
    "additionalRedFlags": ["..."]
  }
  ```
  `verified: false` when the description shows signs of being a ghost job
  (vague responsibilities, no real requirements) or a mismatch between the
  stated experience level and an "intern"/"fresher" title.
- Parse the JSON response defensively — strip code fences if present, wrap in
  try/catch, and skip storing a score (leave `fitScore` null) rather than
  crashing the run if parsing fails.
- Merge `additionalRedFlags` into the job's `redFlags` array.

**Done when:** running this against a batch of stored jobs populates `fitScore`,
`fitReason`, `verified`, and `redFlags` correctly, and the Telegram digest
(Phase 4) sorts by `fitScore` descending.

---

## Phase 7 — Wellfound connector

**Goal:** second source, light HTML scrape, no auth.

**File:** `src/connectors/wellfound.ts`

**Behavior:**
- Fetch Wellfound's India job search results page(s) for relevant keywords with
  `fetch`, parse with `cheerio`.
- Extract the same raw shape as the Adzuna connector.
- Add a small delay between requests (1-2s) to be a polite, low-volume client —
  this is a personal tool checking once a day, not a scraper hammering the site.
- Same try/catch-per-request pattern as Adzuna, so a layout change on
  Wellfound's side degrades gracefully (logs an error, doesn't kill the run)
  rather than crashing everything.

**Done when:** standalone run returns real Wellfound listings, and they flow
through the existing normalize/dedupe/store/classify/deliver pipeline with no
changes needed to those stages.

---

## Phase 8 — LinkedIn via Gmail alert parsing

**Goal:** third source, reading your own Gmail inbox for LinkedIn job-alert
emails — no LinkedIn scraping or automation of any kind.

**Manual setup (outside this codebase, do first):**
1. On LinkedIn, create several saved job searches (keyword + location
   combinations matching `SEARCH_KEYWORDS`), each with email alerts turned on.
2. In Google Cloud Console, create a project, enable the Gmail API, create OAuth
   2.0 credentials (Desktop app type), download client ID + secret into `.env`.

**File:** `scripts/getGmailRefreshToken.ts`
- A one-time, manually-run script: opens the OAuth consent flow in a browser,
  you approve access to your own Gmail (read-only scope:
  `https://www.googleapis.com/auth/gmail.readonly`), the script prints a
  refresh token to paste into `.env` as `GOOGLE_REFRESH_TOKEN`. This only ever
  needs to run once.

**File:** `src/connectors/linkedinGmail.ts`
- Use `googleapis` with the stored refresh token to query Gmail for messages
  matching `from:jobs-noreply@linkedin.com` (or the actual sender address —
  confirm by checking a real alert email) from the last 24 hours.
- Parse each email's HTML body for job title, company, location, and the apply
  link. LinkedIn alert emails have a fairly consistent structure — extract with
  `cheerio` against the email HTML the same way as a scraped page.
- Map to the same raw shape as the other connectors.

**Done when:** with at least one real LinkedIn alert email sitting in the inbox,
running this connector standalone extracts correct title/company/location/link
from it.

---

## Phase 9 — Deployment to Railway

**Goal:** the whole pipeline runs automatically, once a day, with no manual
trigger needed.

**Steps:**
1. `npm install -g @railway/cli`, `railway login`.
2. `railway init` in the repo root to create a new Railway project.
3. Add a Postgres instance via the Railway dashboard (or `railway add`) —
   copy the generated connection string into the project's `DATABASE_URL`
   variable in Railway's dashboard (not into a committed file).
4. Set every other variable from section 4 in the Railway dashboard's
   Variables tab.
5. `railway.json` in the repo root:
   ```json
   {
     "$schema": "https://railway.com/railway.schema.json",
     "build": {
       "builder": "NIXPACKS"
     },
     "deploy": {
       "startCommand": "npm run build && npm run start",
       "cronSchedule": "30 1 * * *",
       "restartPolicyType": "NEVER"
     }
   }
   ```
   `"30 1 * * *"` runs at 01:30 UTC = 07:00 IST daily — adjust to whatever wake
   time actually fits. `restartPolicyType: "NEVER"` matters: this is a
   run-once-and-exit job, not a service that should be restarted if it exits
   cleanly.
6. Run `npx prisma migrate deploy` against the Railway Postgres instance (via
   `railway run npx prisma migrate deploy`) before the first scheduled run.
7. `railway up` to deploy. Optionally connect the GitHub repo in the Railway
   dashboard for auto-deploy on push instead of manual `railway up` each time.

**Done when:** the Railway dashboard shows a successful manually-triggered run
first (use "Run now" if available, or temporarily set a near-future
`cronSchedule` to test), producing a real Telegram digest, and a `RunLog` row
in the deployed Postgres with `status: "success"`.

---

## Phase 10 — Validation checklist (run through after Phase 9)

- [ ] A run with zero new jobs (everything deduped) still completes and doesn't
      send an empty/broken Telegram message.
- [ ] A connector failure (temporarily break one on purpose, e.g. bad API key)
      doesn't stop the other connectors or crash the whole run — check `RunLog`
      shows a `"partial"` status with the error captured.
- [ ] A job containing one of the rule-based red-flag phrases actually shows up
      flagged in the delivered digest, not silently dropped.
- [ ] Fit scores are actually influencing digest order — spot-check a couple of
      low-relevance jobs land near the bottom.
- [ ] Running the pipeline twice in a row on the same day doesn't re-deliver
      the same jobs a second time.
- [ ] The scheduled Railway cron run actually fires unattended (check the next
      morning without manually triggering anything).

## 11. Deferred — build later, not now

- **Naukri connector** — needs `playwright` + residential proxy rotation to get
  past anti-bot protection; give it its own phase when the rest is stable.
- **X monitoring** — official API is pay-per-use now; revisit once the rest of
  the pipeline proves useful enough to justify the cost.
- **LinkedIn hiring-post monitoring** — intentionally stays a manual,
  Claude-in-Chrome-assisted process, not part of this backend.
- **MCA company verification lookup** — nice-to-have addition to Phase 6's
  fake-job checks, not required for v1.
