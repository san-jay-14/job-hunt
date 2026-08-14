/**
 * Classification — fit score + fake/ghost-job flags.
 *
 * Step A (cheap, no LLM): scan the description for known scam phrases and tag
 * hits in redFlags. Flagged jobs are NOT dropped, just tagged, and they skip
 * the LLM (fitScore stays null).
 *
 * Step B (one LLM call per surviving job): score the job against the resume and
 * detect ghost-job signals. The response is parsed defensively — a parse
 * failure leaves the row unscored rather than crashing the run.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import type { Job } from "@prisma/client";

import { CLASSIFIER_MODEL, getAnthropic } from "../lib/anthropic";
import { prisma } from "../lib/db";

/** Step A rule-based red-flag phrases, matched case-insensitively. */
const RED_FLAG_PHRASES = [
  "registration fee",
  "training fee",
  "security deposit",
  "laptop fee",
  "refundable deposit",
  "whatsapp only",
  "telegram only",
];

interface ScoreResult {
  fitScore: number;
  fitReason: string;
  verified: boolean;
  additionalRedFlags: string[];
}

/** Step A — return any red-flag phrases present in the description. */
export function ruleBasedFlags(description: string): string[] {
  const text = description.toLowerCase();
  return RED_FLAG_PHRASES.filter((phrase) => text.includes(phrase));
}

let resumeLoaded = false;
let cachedResume: string | null = null;

/**
 * Load the résumé text, cached for the process. Prefers the RESUME_TEXT env var
 * (used in deployment, since resume.txt is gitignored and absent in the
 * container) and falls back to a local resume.txt. Returns null if neither is
 * available, so classification can degrade gracefully instead of crashing.
 */
function loadResume(): string | null {
  if (resumeLoaded) return cachedResume;
  resumeLoaded = true;

  const fromEnv = process.env.RESUME_TEXT?.trim();
  if (fromEnv) {
    cachedResume = fromEnv;
    return cachedResume;
  }

  try {
    const content = readFileSync(path.resolve(process.cwd(), "resume.txt"), "utf8").trim();
    cachedResume = content || null;
  } catch {
    cachedResume = null;
  }
  return cachedResume;
}

/** Trim, drop empties, de-duplicate. */
function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Defensively parse the model's JSON, tolerating code fences / stray prose. */
function parseScore(raw: string): ScoreResult | null {
  let s = raw.trim();
  // Strip a ```json ... ``` (or ``` ... ```) fence if present.
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  // Fall back to the outermost { ... } if the model added surrounding prose.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }

  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    if (typeof obj.fitScore !== "number") return null;
    return {
      fitScore: clampScore(obj.fitScore),
      fitReason: typeof obj.fitReason === "string" ? obj.fitReason : "",
      verified: obj.verified === true,
      additionalRedFlags: Array.isArray(obj.additionalRedFlags)
        ? obj.additionalRedFlags.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Step B — one LLM call to score a single job against the resume. */
async function scoreJob(
  client: Anthropic,
  resume: string,
  job: Job
): Promise<ScoreResult | null> {
  const system =
    "You are a job-fit classifier for a single job seeker. " +
    "Respond with ONLY a JSON object and nothing else — no prose, no code fences.";

  const user =
    `RESUME:\n${resume}\n\n` +
    `JOB POSTING:\n` +
    `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n` +
    `Description:\n${job.description}\n\n` +
    `Return ONLY this JSON:\n` +
    `{"fitScore": <integer 0-100>, "fitReason": "<one sentence>", ` +
    `"verified": <true|false>, "additionalRedFlags": ["<phrase>", ...]}\n\n` +
    `fitScore is how well the resume matches this posting (higher = better fit). ` +
    `Set verified to false if the posting shows signs of being a ghost job ` +
    `(vague responsibilities, no real requirements) or a mismatch between the ` +
    `stated experience level and an "intern"/"fresher" title; otherwise true. ` +
    `additionalRedFlags lists any other scam/ghost signals you notice (empty array if none).`;

  try {
    const response = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });

    let raw = "";
    for (const block of response.content) {
      if (block.type === "text") raw += block.text;
    }
    return parseScore(raw);
  } catch (err) {
    console.error(`[classify] LLM call failed for "${job.title}":`, err);
    return null;
  }
}

/**
 * Classify a batch of stored jobs in place (updates their DB rows).
 *
 * Rule-flagged jobs are tagged and skipped; the rest get an LLM score. A job
 * whose LLM call or JSON parse fails is left unscored (fitScore null) rather
 * than aborting the batch.
 */
export async function classifyJobs(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;

  const resume = loadResume();
  const client = resume ? getAnthropic() : null;
  if (!resume) {
    console.warn(
      "[classify] no résumé (set RESUME_TEXT env or add resume.txt) — running rule flags only, skipping LLM scoring"
    );
  }

  for (const job of jobs) {
    const flags = ruleBasedFlags(job.description);
    if (flags.length > 0) {
      await prisma.job.update({
        where: { id: job.id },
        data: { redFlags: uniq([...job.redFlags, ...flags]) },
      });
      console.log(`[classify] "${job.title}" flagged (rule): ${flags.join(", ")} — skipping LLM`);
      continue;
    }

    // No résumé → skip LLM scoring, leave fitScore null (still delivered).
    if (!resume || !client) continue;

    const result = await scoreJob(client, resume, job);
    if (!result) {
      console.warn(`[classify] "${job.title}" — no score stored (LLM/parse failure)`);
      continue;
    }

    await prisma.job.update({
      where: { id: job.id },
      data: {
        fitScore: result.fitScore,
        fitReason: result.fitReason,
        verified: result.verified,
        redFlags: uniq([...job.redFlags, ...result.additionalRedFlags]),
      },
    });
    console.log(`[classify] "${job.title}" → fit ${result.fitScore}, verified=${result.verified}`);
  }
}
