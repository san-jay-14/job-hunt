/**
 * Wellfound connector — a light HTML scrape, no auth.
 *
 * Wellfound is a Next.js app: the job data isn't in server-rendered DOM cards,
 * it's embedded in the `#__NEXT_DATA__` script as an Apollo cache. We fetch the
 * India role/location search page for each keyword, pull that script out with
 * cheerio, and read the `JobListingSearchResult` entries (company names come
 * from the `StartupResult` entries that reference them).
 *
 * This is a personal, once-a-day client: one request per keyword with a short
 * delay between them, and each request wrapped in try/catch so a layout change
 * degrades gracefully (logs, skips) instead of killing the run.
 */

import * as cheerio from "cheerio";
import type { RawJob } from "../types";

const BASE = "https://wellfound.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const REQUEST_DELAY_MS = 1500;

/** Minimal shape of a JobListingSearchResult in the Apollo cache. */
interface WellfoundJob {
  __typename?: string;
  id?: string | number;
  title?: string;
  slug?: string;
  description?: string;
  locationNames?: string[];
  remote?: boolean;
  liveStartAt?: string | number | null;
}

interface WellfoundStartup {
  __typename?: string;
  name?: string;
  highlightedJobListings?: { __ref?: string }[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseKeywords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Slugify to a Wellfound URL segment (lowercase, hyphen-separated). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Turn a search keyword into a Wellfound role slug. Wellfound's role taxonomy
 * is seniority-agnostic, so we strip intern/fresher qualifiers; an unknown slug
 * simply redirects to the general India jobs page (still real listings).
 */
function toRoleSlug(keyword: string): string {
  const core = keyword
    .toLowerCase()
    .replace(/\b(intern|internship|fresher|entry[-\s]?level|junior|jr)\b/g, " ")
    .trim();
  return slugify(core);
}

/** Parse Wellfound's liveStartAt (epoch seconds/ms or ISO string) to a Date. */
function parseDate(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Extract raw jobs from a Wellfound search page's embedded Apollo cache. */
export function extractJobs(html: string): RawJob[] {
  const $ = cheerio.load(html);
  const script = $("script#__NEXT_DATA__").first().html();
  if (!script) return [];

  let cache: Record<string, unknown>;
  try {
    const data = JSON.parse(script);
    cache = data?.props?.pageProps?.apolloState?.data;
  } catch {
    return [];
  }
  if (!cache || typeof cache !== "object") return [];

  // Map job id -> company name via each startup's highlighted listings.
  const companyByJobId = new Map<string, string>();
  for (const entry of Object.values(cache)) {
    const startup = entry as WellfoundStartup;
    if (startup?.__typename !== "StartupResult") continue;
    for (const ref of startup.highlightedJobListings ?? []) {
      const id = (ref?.__ref ?? "").replace("JobListingSearchResult:", "");
      if (id) companyByJobId.set(id, startup.name ?? "");
    }
  }

  const jobs: RawJob[] = [];
  for (const entry of Object.values(cache)) {
    const job = entry as WellfoundJob;
    if (job?.__typename !== "JobListingSearchResult") continue;

    const id = job.id != null ? String(job.id) : "";
    const slug = job.slug ?? "";
    const locations = Array.isArray(job.locationNames) ? job.locationNames : [];
    const location = locations.length > 0 ? locations.join(", ") : job.remote ? "Remote" : "India";

    jobs.push({
      source: "wellfound",
      sourceId: id || null,
      title: job.title ?? "",
      company: companyByJobId.get(id) ?? "",
      location,
      description: job.description ?? "",
      applyUrl: id && slug ? `${BASE}/jobs/${id}-${slug}` : `${BASE}/jobs/${id}`,
      postedAt: parseDate(job.liveStartAt),
    });
  }
  return jobs;
}

/**
 * Fetch raw job listings from Wellfound for every keyword in SEARCH_KEYWORDS,
 * one polite request at a time.
 */
export async function fetchWellfoundJobs(): Promise<RawJob[]> {
  const keywords = parseKeywords(process.env.SEARCH_KEYWORDS);
  const locationSlug = slugify(process.env.SEARCH_LOCATION ?? "India") || "india";

  if (keywords.length === 0) {
    console.warn("[wellfound] SEARCH_KEYWORDS is empty — nothing to fetch");
    return [];
  }

  const jobs: RawJob[] = [];

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    try {
      const roleSlug = toRoleSlug(keyword);
      const url = roleSlug
        ? `${BASE}/role/l/${roleSlug}/${locationSlug}`
        : `${BASE}/location/${locationSlug}`;

      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const html = await res.text();
      const found = extractJobs(html);
      jobs.push(...found);
      console.log(`[wellfound] "${keyword}" (${roleSlug || locationSlug}) → ${found.length} listings`);
    } catch (err) {
      console.error(`[wellfound] keyword "${keyword}" failed:`, err);
      // continue with the next keyword
    }

    // Be a polite, low-volume client — small delay between requests.
    if (i < keywords.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return jobs;
}

// Standalone runner:  npx ts-node src/connectors/wellfound.ts
if (require.main === module) {
  require("dotenv").config();
  fetchWellfoundJobs()
    .then((jobs) => {
      console.log(`\n[wellfound] total: ${jobs.length} raw jobs`);
      console.log(JSON.stringify(jobs.slice(0, 5), null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
