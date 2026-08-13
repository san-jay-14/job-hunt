/**
 * Adzuna connector — the simplest source (plain REST API, no auth flow).
 *
 * Hits the Adzuna jobs search endpoint once per keyword (page 1 only for v1,
 * since the free tier is ~33 calls/day) and returns raw, un-normalized job
 * objects. workType/roleType are deliberately left off here — they get inferred
 * later in normalization (Phase 3).
 */

import type { RawJob } from "../types";

/** Shape of a single result in the Adzuna search response (fields we use). */
interface AdzunaResult {
  id?: string | number;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
}

interface AdzunaSearchResponse {
  results?: AdzunaResult[];
}

const ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs";

/** Split SEARCH_KEYWORDS ("a,b,c") into a trimmed, non-empty list. */
function parseKeywords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Map one Adzuna result onto our RawJob shape. */
function toRawJob(result: AdzunaResult): RawJob {
  return {
    source: "adzuna",
    sourceId: result.id != null ? String(result.id) : null,
    title: result.title ?? "",
    company: result.company?.display_name ?? "",
    location: result.location?.display_name ?? "",
    description: result.description ?? "",
    applyUrl: result.redirect_url ?? "",
    postedAt: result.created ? new Date(result.created) : null,
  };
}

/**
 * Fetch raw job listings from Adzuna for every keyword in SEARCH_KEYWORDS.
 *
 * Each keyword is fetched inside its own try/catch, so one failing keyword
 * (network blip, rate limit, weird response) logs an error and is skipped
 * rather than killing the whole run.
 */
export async function fetchAdzunaJobs(): Promise<RawJob[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const country = (process.env.ADZUNA_COUNTRY ?? "in").toLowerCase();
  const where = process.env.SEARCH_LOCATION ?? "";
  const keywords = parseKeywords(process.env.SEARCH_KEYWORDS);

  if (!appId || !appKey) {
    throw new Error(
      "Adzuna credentials missing — set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env"
    );
  }
  if (keywords.length === 0) {
    console.warn("[adzuna] SEARCH_KEYWORDS is empty — nothing to fetch");
    return [];
  }

  const jobs: RawJob[] = [];

  for (const keyword of keywords) {
    try {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what: keyword,
        where,
      });
      // Page 1 only for v1 — free tier is ~33 calls/day, so no deep pagination.
      const url = `${ADZUNA_BASE}/${country}/search/1?${params.toString()}`;

      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
      }

      const data = (await res.json()) as AdzunaSearchResponse;
      const results = data.results ?? [];
      const mapped = results.map(toRawJob);
      jobs.push(...mapped);
      console.log(`[adzuna] "${keyword}" → ${mapped.length} listings`);
    } catch (err) {
      console.error(`[adzuna] keyword "${keyword}" failed:`, err);
      // continue with the next keyword
    }
  }

  return jobs;
}

// Standalone runner so this connector can be verified on its own:
//   npx ts-node src/connectors/adzuna.ts
if (require.main === module) {
  require("dotenv").config();
  fetchAdzunaJobs()
    .then((jobs) => {
      console.log(`\n[adzuna] total: ${jobs.length} raw jobs`);
      console.log(JSON.stringify(jobs, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
