/**
 * Telegram delivery — the only output surface for this tool.
 *
 * sendDigest formats a list of jobs into one or more Markdown messages (highest
 * fit score first, then newest) and POSTs them to the Bot API. Telegram caps a
 * message around 4096 chars, so long digests are split into several sequential
 * messages rather than truncated.
 */

import type { Job } from "@prisma/client";

// Stay comfortably under Telegram's ~4096 char hard limit.
const MESSAGE_LIMIT = 4000;

/**
 * Neutralize legacy-Markdown control characters in dynamic text so a stray
 * `_`, `*`, `` ` `` or `[` in a job title/company doesn't break parsing (which
 * makes the Bot API reject the whole message with a 400).
 */
function md(text: string): string {
  return text.replace(/[_*`\[]/g, " ").replace(/\s+/g, " ").trim();
}

/** Format one job as a Markdown block. */
function formatBlock(job: Job): string {
  const lines: string[] = [];
  lines.push(`*${md(job.title)}* — ${md(job.company)}`);

  const meta = [job.location ? md(job.location) : "", job.workType ?? ""]
    .filter((part) => part.length > 0)
    .join(" · ");
  if (meta) lines.push(`📍 ${meta}`);

  // Fit score only appears once scoring exists (Phase 6); null until then.
  if (job.fitScore != null) lines.push(`⭐ Fit: ${job.fitScore}/100`);

  lines.push(`🔗 ${job.applyUrl}`);
  return lines.join("\n");
}

/** Highest fit score first (nulls last), then newest first. */
function sortForDigest(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const fa = a.fitScore ?? -1;
    const fb = b.fitScore ?? -1;
    if (fb !== fa) return fb - fa;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

/** Pack a header + job blocks into messages that each stay under the limit. */
function packMessages(header: string, blocks: string[]): string[] {
  const messages: string[] = [];
  let current = header;

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > MESSAGE_LIMIT && current) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** POST a single message to the Telegram Bot API. */
async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }
}

/**
 * Send a digest of jobs to the configured Telegram chat. No-op (nothing sent)
 * when there are no jobs, so an empty run never produces a broken message.
 */
export async function sendDigest(jobs: Job[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "Telegram credentials missing — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env"
    );
  }

  if (jobs.length === 0) {
    console.log("[telegram] no jobs to deliver — skipping send");
    return;
  }

  const sorted = sortForDigest(jobs);
  const header = `🧑‍💻 *Job digest* — ${jobs.length} ${jobs.length === 1 ? "match" : "matches"}`;
  const blocks = sorted.map(formatBlock);
  const messages = packMessages(header, blocks);

  for (const text of messages) {
    await sendMessage(token, chatId, text);
  }
  console.log(`[telegram] delivered ${jobs.length} jobs in ${messages.length} message(s)`);
}

// Standalone runner so delivery can be verified on its own with fake data:
//   npx ts-node src/lib/telegram.ts
if (require.main === module) {
  require("dotenv").config();
  const now = new Date();
  const base = {
    sourceId: null,
    description: "",
    postedAt: now,
    fitReason: null,
    verified: true,
    redFlags: [] as string[],
    delivered: false,
    createdAt: now,
  };
  const fake: Job[] = [
    {
      ...base,
      id: "fake1",
      source: "adzuna",
      title: "Frontend Developer Intern",
      company: "Acme Corp",
      location: "Bangalore, Karnataka",
      workType: "remote",
      roleType: "intern",
      applyUrl: "https://example.com/apply/1",
      dedupeKey: "fake1",
      fitScore: 87,
    },
    {
      ...base,
      id: "fake2",
      source: "adzuna",
      title: "React Developer Intern",
      company: "Beta Labs",
      location: "Remote, India",
      workType: "remote",
      roleType: "intern",
      applyUrl: "https://example.com/apply/2",
      dedupeKey: "fake2",
      fitScore: 72,
    },
    {
      ...base,
      id: "fake3",
      source: "adzuna",
      title: "Fresher Software Engineer",
      company: "Gamma Systems",
      location: "Hyderabad, Telangana",
      workType: "onsite",
      roleType: "fresher",
      applyUrl: "https://example.com/apply/3",
      dedupeKey: "fake3",
      fitScore: null, // no score yet — demonstrates "fit score once it exists"
    },
  ];

  sendDigest(fake)
    .then(() => console.log("done"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
