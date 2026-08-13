/**
 * Resume optimizer (user-triggered, local only).
 *
 *   npm run optimize -- <jobRef> [<jobRef> ...]
 *
 * For each selected job (by its short #ref shown in the Telegram digest), it
 * tailors your base resume.tex to the job — truthfully reordering/rephrasing
 * existing content, never inventing anything — compiles it with pdflatex (with
 * an error-feedback retry loop), and writes the PDF to output/.
 */

import "dotenv/config";

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";

import type Anthropic from "@anthropic-ai/sdk";
import type { Job } from "@prisma/client";

import { getAnthropic, RESUME_MODEL } from "./lib/anthropic";
import { prisma } from "./lib/db";
import { compileLatex, extractLatexErrors } from "./lib/latex";

const RESUME_TEX = path.resolve(process.cwd(), "resume.tex");
const OUTPUT_DIR = path.resolve(process.cwd(), "output");
const MAX_COMPILE_ATTEMPTS = 3;

/** Parse CLI args like "42", "#42" into a unique list of refs. */
function parseRefs(args: string[]): number[] {
  const refs: number[] = [];
  for (const a of args) {
    const n = Number.parseInt(a.replace(/^#/, ""), 10);
    if (Number.isInteger(n)) refs.push(n);
  }
  return [...new Set(refs)];
}

/** Collect text blocks from a response and strip any ```latex fences. */
function extractTex(response: Anthropic.Message): string {
  let raw = "";
  for (const block of response.content) {
    if (block.type === "text") raw += block.text;
  }
  return raw
    .trim()
    .replace(/^```(?:latex|tex)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

/** Filesystem-safe token from arbitrary text. */
function safeName(text: string): string {
  return (
    text
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "resume"
  );
}

/** One LLM call to tailor the base resume to a job. */
async function tailorResume(client: Anthropic, baseTex: string, job: Job): Promise<string> {
  const system =
    "You are an expert resume editor and LaTeX author. You tailor an existing " +
    "LaTeX resume to a specific job posting.\n" +
    "Rules:\n" +
    "1. Output ONLY the complete LaTeX document, compilable with pdflatex — no prose, no code fences.\n" +
    "2. Preserve the document's structure, packages, and formatting. Edit content, don't redesign.\n" +
    "3. Reorder and rephrase existing bullets/skills to emphasize what's relevant to this job and mirror its wording.\n" +
    "4. You may tighten phrasing and adjust the summary/objective.\n" +
    "5. NEVER invent experience, employers, skills, dates, or metrics that aren't in the original. Only reorganize and rephrase truthfully.\n" +
    "6. Keep the length the same (if it was one page, keep it one page).";

  const user =
    `JOB POSTING:\n` +
    `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n` +
    `Description:\n${job.description}\n\n` +
    `CURRENT RESUME (LaTeX source):\n${baseTex}\n\n` +
    `Return the full tailored LaTeX document only.`;

  const response = await client.messages.create({
    model: RESUME_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  });
  return extractTex(response);
}

/** One LLM call to fix LaTeX that failed to compile. */
async function fixLatex(client: Anthropic, brokenTex: string, errors: string): Promise<string> {
  const system =
    "You are a LaTeX expert. The following LaTeX failed to compile with pdflatex. " +
    "Fix the errors and return ONLY the complete corrected LaTeX document (no prose, no code fences). " +
    "Make the minimal changes needed to compile; do not change the résumé's content.";
  const user = `LaTeX:\n${brokenTex}\n\npdflatex errors:\n${errors}\n\nReturn the corrected full document only.`;

  const response = await client.messages.create({
    model: RESUME_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  });
  return extractTex(response);
}

/** Tailor, compile (with retries), and save one job's resume. Returns success. */
async function optimizeForJob(client: Anthropic, baseTex: string, job: Job): Promise<boolean> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "resume-"));
  let tex = await tailorResume(client, baseTex, job);

  let result = await compileOnce(workDir, tex);
  let attempt = 1;
  while (!result.ok && !result.toolMissing && attempt < MAX_COMPILE_ATTEMPTS) {
    attempt++;
    console.log(`  compile attempt ${attempt - 1} failed — asking ${RESUME_MODEL} to fix the LaTeX...`);
    tex = await fixLatex(client, tex, extractLatexErrors(result.log));
    result = await compileOnce(workDir, tex);
  }

  if (result.toolMissing) {
    throw new Error(
      "pdflatex not found. Install a LaTeX toolchain (MiKTeX or TeX Live) and ensure `pdflatex` is on your PATH."
    );
  }
  if (!result.ok) {
    console.error(`  ✗ could not compile after ${MAX_COMPILE_ATTEMPTS} attempts.`);
    return false;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const base = `${safeName(job.company)}_${safeName(job.title)}`;
  const outPdf = path.join(OUTPUT_DIR, `${base}.pdf`);
  const outTex = path.join(OUTPUT_DIR, `${base}.tex`);
  await copyFile(result.pdfPath!, outPdf);
  await writeFile(outTex, tex, "utf8");
  console.log(`  ✓ ${path.relative(process.cwd(), outPdf)}`);
  return true;
}

/** Write the tex to the work dir and compile it once. */
async function compileOnce(workDir: string, tex: string) {
  await writeFile(path.join(workDir, "resume.tex"), tex, "utf8");
  return compileLatex(workDir, "resume");
}

async function main(): Promise<void> {
  const refs = parseRefs(process.argv.slice(2));
  if (refs.length === 0) {
    console.error("Usage: npm run optimize -- <jobRef> [<jobRef> ...]   (e.g. npm run optimize -- 42 43)");
    process.exitCode = 1;
    return;
  }

  if (!existsSync(RESUME_TEX)) {
    console.error(`Missing resume.tex at ${RESUME_TEX}\nAdd your resume as a LaTeX file there first.`);
    process.exitCode = 1;
    return;
  }
  const baseTex = await readFile(RESUME_TEX, "utf8");

  const jobs = await prisma.job.findMany({ where: { ref: { in: refs } } });
  const found = new Set(jobs.map((j) => j.ref));
  for (const r of refs) {
    if (!found.has(r)) console.warn(`No job found with #${r} — skipping.`);
  }
  if (jobs.length === 0) {
    console.error("None of the given refs matched a stored job.");
    process.exitCode = 1;
    return;
  }

  const client = getAnthropic();
  let ok = 0;
  for (const job of jobs) {
    console.log(`\n#${job.ref}  ${job.title} @ ${job.company}`);
    try {
      if (await optimizeForJob(client, baseTex, job)) ok++;
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nDone: ${ok}/${jobs.length} resume(s) written to ${path.relative(process.cwd(), OUTPUT_DIR)}/`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
