/**
 * pdflatex compile helper for the resume optimizer.
 *
 * Runs pdflatex in a working directory (twice, for cross-references), then
 * reports whether a PDF was produced and surfaces the log for the retry loop.
 * pdflatex exits non-zero on LaTeX errors, so success is judged by PDF
 * existence, not the exit code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface CompileResult {
  ok: boolean;
  pdfPath: string | null;
  log: string;
  /** True when the pdflatex binary itself isn't installed (ENOENT). */
  toolMissing: boolean;
}

/** Compile `<jobName>.tex` in `workDir` to a PDF. */
export async function compileLatex(workDir: string, jobName: string): Promise<CompileResult> {
  const texPath = path.join(workDir, `${jobName}.tex`);
  const pdfPath = path.join(workDir, `${jobName}.pdf`);
  const logPath = path.join(workDir, `${jobName}.log`);
  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    `-output-directory=${workDir}`,
    texPath,
  ];

  let toolMissing = false;
  // Two passes so references/labels settle.
  for (let pass = 0; pass < 2; pass++) {
    try {
      await execFileAsync("pdflatex", args, { cwd: workDir, timeout: 60_000 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        toolMissing = true;
        break;
      }
      // Otherwise pdflatex exited non-zero due to a LaTeX error — inspect the log.
    }
  }

  let log = "";
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    /* no log produced */
  }

  const ok = !toolMissing && existsSync(pdfPath);
  return { ok, pdfPath: ok ? pdfPath : null, log, toolMissing };
}

/** Pull the salient error lines out of a pdflatex log for the fix prompt. */
export function extractLatexErrors(log: string): string {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // LaTeX errors start with "!", line-number markers look like "l.42 ...".
    if (line.startsWith("!") || /^l\.\d+/.test(line)) {
      out.push(...lines.slice(i, i + 3));
    }
  }
  const joined = out.join("\n").trim();
  // Fall back to the tail of the log if we couldn't isolate errors.
  return (joined || log.slice(-2000)).slice(0, 3000);
}
