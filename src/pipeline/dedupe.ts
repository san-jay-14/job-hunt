/**
 * Drop duplicates before inserting.
 *
 * Two layers:
 *  1. Exact: skip any job whose dedupeKey already exists in the DB, or that
 *     repeats within the current batch (same listing pulled under two keywords).
 *  2. Near: within the same company + location, compare titles with
 *     string-similarity; anything above SIMILARITY_THRESHOLD is treated as a
 *     duplicate too (e.g. slightly different title wording across sources).
 *
 * Returns only the jobs that are genuinely new and should be inserted.
 */

import stringSimilarity from "string-similarity";
import { prisma } from "../lib/db";
import type { NormalizedJob } from "../types";

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Is `job` a near-duplicate (by title) of any job in the same company+location,
 * looking at both already-accepted batch jobs and rows already in the DB?
 */
async function isNearDuplicate(
  job: NormalizedJob,
  accepted: NormalizedJob[]
): Promise<boolean> {
  const batchTitles = accepted
    .filter((a) => a.company === job.company && a.location === job.location)
    .map((a) => a.title);

  const dbRows = await prisma.job.findMany({
    where: { company: job.company, location: job.location },
    select: { title: true },
  });

  const candidateTitles = [...batchTitles, ...dbRows.map((r) => r.title)];

  return candidateTitles.some(
    (title) => stringSimilarity.compareTwoStrings(job.title, title) > SIMILARITY_THRESHOLD
  );
}

/**
 * Filter a normalized batch down to the jobs that are new relative to both the
 * DB and to earlier entries in the same batch.
 */
export async function dedupeJobs(jobs: NormalizedJob[]): Promise<NormalizedJob[]> {
  const accepted: NormalizedJob[] = [];

  for (const job of jobs) {
    // 1a. exact dedupeKey already in the DB → skip
    const existing = await prisma.job.findUnique({
      where: { dedupeKey: job.dedupeKey },
    });
    if (existing) continue;

    // 1b. exact dedupeKey already seen earlier in this batch → skip
    if (accepted.some((a) => a.dedupeKey === job.dedupeKey)) continue;

    // 2. near-duplicate title within the same company + location → skip
    if (await isNearDuplicate(job, accepted)) continue;

    accepted.push(job);
  }

  return accepted;
}
