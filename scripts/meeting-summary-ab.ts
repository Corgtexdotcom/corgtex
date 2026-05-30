// Meeting-summary A/B harness.
//
// Runs the block-extraction + summary model calls (the same prompts used by
// the meeting-summary agent) against a raw transcript file, across one or more
// models, so you can compare summary quality before committing to a model tier.
//
// Usage:
//   MODEL_API_KEY=... npx tsx scripts/meeting-summary-ab.ts <transcript.txt> [model1] [model2] ...
//
// Defaults to comparing the `quality` and `excellent` tiers if no models are
// passed. Example:
//   npx tsx scripts/meeting-summary-ab.ts ./may27.txt google/gemini-2.5-flash openai/gpt-4o
//
// Notes:
// - This imports the SAME shared prompt constants from @corgtex/domain that the
//   meeting-summary agent uses, so the prompts under test cannot drift from prod.
// - It calls the model provider's OpenAI-compatible HTTP API directly (OpenRouter
//   by default) rather than going through defaultModelGateway. That is deliberate:
//   the gateway enforces DB-backed workspace budget checks and usage logging, which
//   require a reachable database and a real workspace. This harness is a fast,
//   DB-free way to eyeball summary quality per model. It does NOT load Corgtex
//   context (open actions/tensions/etc.) or persist anything.
//
// Reads MODEL_API_KEY and MODEL_BASE_URL from the environment. The easiest way to
// run it with production credentials without exposing the key is:
//   railway run -- npx tsx scripts/meeting-summary-ab.ts ./transcript.txt [model ...]

import { readFileSync } from "node:fs";
import { resolveModel } from "@corgtex/models";
import {
  MEETING_BLOCK_EXTRACTION_INSTRUCTION,
  MEETING_BLOCK_SCHEMA_HINT,
  MEETING_SUMMARY_SYSTEM_PROMPT,
  normalizeMeetingBlocks,
} from "@corgtex/domain";

const API_KEY = process.env.MODEL_API_KEY ?? "";
const BASE_URL = (process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

type ChatMessage = { role: "system" | "user"; content: string };

async function chatCompletion(model: string, messages: ChatMessage[], jsonMode: boolean): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: jsonMode ? 0 : 0.2,
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function parseJsonLoose(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Could not parse JSON from model output.");
  }
}

async function runForModel(model: string, transcript: string) {
  const blockMessages: ChatMessage[] = [
    {
      role: "system",
      content: `${MEETING_BLOCK_EXTRACTION_INSTRUCTION}\n\nReturn ONLY a JSON object matching this shape:\n${MEETING_BLOCK_SCHEMA_HINT}`,
    },
    { role: "user", content: JSON.stringify({ transcript }) },
  ];
  let blockRaw: string;
  try {
    blockRaw = await chatCompletion(model, blockMessages, true);
  } catch (error) {
    // Some providers reject response_format json_object; retry without it.
    if (/structured-outputs|response_format|json/i.test(String(error))) {
      blockRaw = await chatCompletion(model, blockMessages, false);
    } else {
      throw error;
    }
  }
  const blocks = normalizeMeetingBlocks(parseJsonLoose(blockRaw));

  const summary = await chatCompletion(model, [
    { role: "system", content: MEETING_SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ transcript, meetingBlocks: blocks }) },
  ], false);

  return { blockCount: blocks.blocks.length, blocks, summary };
}

async function main() {
  const [transcriptPath, ...modelArgs] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error("Usage: npx tsx scripts/meeting-summary-ab.ts <transcript.txt> [model ...]");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("MODEL_API_KEY is not set. Run via: railway run -- npx tsx scripts/meeting-summary-ab.ts ...");
    process.exit(1);
  }
  const transcript = readFileSync(transcriptPath, "utf8");
  const models = modelArgs.length > 0
    ? modelArgs
    : [resolveModel("quality"), resolveModel("excellent")];

  for (const model of models) {
    console.log("\n" + "=".repeat(80));
    console.log(`MODEL: ${model}`);
    console.log("=".repeat(80));
    const started = Date.now();
    try {
      const result = await runForModel(model, transcript);
      console.log(`\n[blocks: ${result.blockCount} | ${Date.now() - started}ms]\n`);
      console.log("--- BLOCK TITLES ---");
      for (const block of result.blocks.blocks) {
        console.log(`  ${block.sequence}. [${block.kind}] ${block.title}`);
      }
      console.log("\n--- SUMMARY ---\n");
      console.log(result.summary);
    } catch (error) {
      console.error(`FAILED for ${model}:`, error instanceof Error ? error.message : error);
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
