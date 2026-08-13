/**
 * Shared domain types for the pipeline.
 *
 * RawJob is what a connector emits (source-shaped, pre-normalization).
 * NormalizedJob is the consistent shape produced by normalize.ts — it mirrors
 * the Prisma `Job` model minus the DB-generated fields (`id`, `createdAt`) and
 * the fields populated by later phases (fitScore/fitReason/verified/redFlags in
 * classification, delivered at delivery time). It's exactly the payload that can
 * be handed to `prisma.job.create({ data })`.
 */

export type JobSource = "adzuna" | "wellfound" | "linkedin";
export type WorkType = "remote" | "onsite" | "hybrid";
export type RoleType = "intern" | "fresher" | "contract" | "fulltime";

/** Raw, source-shaped job as it comes out of a connector, before normalization. */
export interface RawJob {
  source: JobSource;
  sourceId: string | null;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
  postedAt: Date | null;
}

/** Consistent, normalized job ready to insert into the `Job` table. */
export interface NormalizedJob {
  source: JobSource;
  sourceId: string | null;
  title: string;
  company: string;
  location: string;
  workType: WorkType | null;
  roleType: RoleType;
  description: string;
  applyUrl: string;
  postedAt: Date | null;
  dedupeKey: string;
}
