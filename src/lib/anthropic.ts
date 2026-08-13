/**
 * Thin wrapper around the Anthropic SDK client.
 *
 * The classifier (Phase 6) is the only LLM caller in the pipeline. Model choice
 * is centralized here so it's trivial to swap.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Model used for per-job fit scoring. Haiku is the cost-appropriate choice here:
 * this is a simple JSON-scoring call made once per job every morning, so a
 * smaller/cheaper model keeps the daily bill low without hurting quality.
 */
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

let client: Anthropic | null = null;

/** Lazily-constructed shared Anthropic client. */
export function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY missing — set it in .env");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}
