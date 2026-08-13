/**
 * Normalize raw, source-specific job objects into one consistent shape.
 *
 * - lowercase + trim company / title / location
 * - infer workType from location/description text
 * - infer roleType from the title
 * - build a stable dedupeKey hash from the normalized company|title|location
 */

import { createHash } from "node:crypto";
import type { NormalizedJob, RawJob, RoleType, WorkType } from "../types";

/** "remote" if the location/description mentions it, otherwise default "onsite". */
function inferWorkType(location: string, description: string): WorkType {
  const text = `${location} ${description}`.toLowerCase();
  return text.includes("remote") ? "remote" : "onsite";
}

/** Classify the role from title keywords; falls back to "fulltime". */
function inferRoleType(title: string): RoleType {
  const t = title.toLowerCase();
  if (t.includes("intern") || t.includes("internship")) return "intern";
  if (t.includes("fresher") || t.includes("entry level") || t.includes("0-1 year")) {
    return "fresher";
  }
  if (t.includes("contract") || t.includes("freelance")) return "contract";
  return "fulltime";
}

/** SHA-1 of `company|title|location` (all already normalized). */
function buildDedupeKey(company: string, title: string, location: string): string {
  return createHash("sha1").update(`${company}|${title}|${location}`).digest("hex");
}

/** Normalize a single raw job. */
export function normalizeJob(raw: RawJob): NormalizedJob {
  const company = raw.company.trim().toLowerCase();
  const title = raw.title.trim().toLowerCase();
  const location = raw.location.trim().toLowerCase();

  return {
    source: raw.source,
    sourceId: raw.sourceId,
    title,
    company,
    location,
    workType: inferWorkType(location, raw.description),
    roleType: inferRoleType(title),
    description: raw.description,
    applyUrl: raw.applyUrl,
    postedAt: raw.postedAt,
    dedupeKey: buildDedupeKey(company, title, location),
  };
}

/** Normalize a batch of raw jobs. */
export function normalizeJobs(raw: RawJob[]): NormalizedJob[] {
  return raw.map(normalizeJob);
}
