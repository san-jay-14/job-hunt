import "dotenv/config";

import { prisma } from "./lib/db";
import { fetchAdzunaJobs } from "./connectors/adzuna";
import { normalizeJobs } from "./pipeline/normalize";
import { dedupeJobs } from "./pipeline/dedupe";
import { classifyJobs } from "./pipeline/classify";
import { sendDigest } from "./lib/telegram";
import type { RawJob } from "./types";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Local start-of-day, used to scope delivery to "today's" jobs. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Full pipeline: collect (Adzuna) → normalize → dedupe → store → deliver.
 *
 * Each stage is wrapped so a single failure is recorded and the run continues
 * rather than crashing. A RunLog row is opened at the start and finalized at
 * the end with counts and an overall status.
 */
async function main(): Promise<void> {
  console.log("pipeline starting");

  const errors: string[] = [];
  let jobsFound = 0;
  let jobsNew = 0;

  const run = await prisma.runLog.create({ data: { status: "partial" } });

  try {
    // 2. Collect from Adzuna (per-keyword failures are already handled inside
    //    the connector; this guard catches a total failure of the source).
    let raw: RawJob[] = [];
    try {
      raw = await fetchAdzunaJobs();
      jobsFound = raw.length;
      console.log(`[pipeline] collected ${jobsFound} raw listings`);
    } catch (err) {
      const msg = `adzuna: ${errMsg(err)}`;
      console.error(`[pipeline] ${msg}`);
      errors.push(msg);
    }

    // 3. Normalize + dedupe, then insert the genuinely new ones.
    try {
      const normalized = normalizeJobs(raw);
      const fresh = await dedupeJobs(normalized);
      if (fresh.length > 0) {
        const result = await prisma.job.createMany({ data: fresh, skipDuplicates: true });
        jobsNew = result.count;
      }
      console.log(`[pipeline] ${jobsNew} new jobs stored (of ${normalized.length} normalized)`);
    } catch (err) {
      const msg = `store: ${errMsg(err)}`;
      console.error(`[pipeline] ${msg}`);
      errors.push(msg);
    }

    // 4-6. Classify today's undelivered jobs, then deliver, then mark delivered.
    try {
      const pending = await prisma.job.findMany({
        where: { delivered: false, createdAt: { gte: startOfToday() } },
      });
      await classifyJobs(pending);

      // Re-query so the digest sees the freshly-written fit scores.
      const toDeliver = await prisma.job.findMany({
        where: { delivered: false, createdAt: { gte: startOfToday() } },
        orderBy: [{ fitScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      });

      await sendDigest(toDeliver);

      if (toDeliver.length > 0) {
        await prisma.job.updateMany({
          where: { id: { in: toDeliver.map((j) => j.id) } },
          data: { delivered: true },
        });
      }
      console.log(`[pipeline] classified ${pending.length}, delivered ${toDeliver.length} jobs`);
    } catch (err) {
      const msg = `deliver: ${errMsg(err)}`;
      console.error(`[pipeline] ${msg}`);
      errors.push(msg);
    }
  } finally {
    // 7. Finalize the RunLog.
    const status = errors.length === 0 ? "success" : jobsFound > 0 ? "partial" : "failed";
    await prisma.runLog.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status, jobsFound, jobsNew, errors },
    });
    console.log(
      `pipeline finished: status=${status} found=${jobsFound} new=${jobsNew} errors=${errors.length}`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
