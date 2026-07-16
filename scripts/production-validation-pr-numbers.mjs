#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseValidationPrNumbers } from "./lib/production-validation.mjs";

function unique(numbers) {
  return [...new Set(numbers)];
}

function parseOptionalPrNumbers(value) {
  return value === undefined || value === null || value === ""
    ? []
    : parseValidationPrNumbers(value);
}

export function parseMergeCommitPrNumbers(message) {
  const firstLine = String(message ?? "").split(/\r?\n/, 1)[0].trim();
  const numbers = [];
  const mergeMatch = firstLine.match(/^Merge pull request #(\d+)\b/i);
  if (mergeMatch) {
    numbers.push(Number(mergeMatch[1]));
  }
  const squashMatch = firstLine.match(/\(#(\d+)\)$/);
  if (squashMatch) {
    numbers.push(Number(squashMatch[1]));
  }
  return unique(numbers);
}

export function prNumbersFromGithubEvent(event) {
  if (!event || typeof event !== "object") return [];

  const numbers = [];
  if (event.pull_request?.number) {
    numbers.push(Number(event.pull_request.number));
  }
  if (Array.isArray(event.workflow_run?.pull_requests)) {
    for (const pullRequest of event.workflow_run.pull_requests) {
      if (pullRequest?.number) numbers.push(Number(pullRequest.number));
    }
  }

  numbers.push(...parseMergeCommitPrNumbers(event.head_commit?.message));
  numbers.push(...parseMergeCommitPrNumbers(event.workflow_run?.head_commit?.message));
  if (Array.isArray(event.commits)) {
    for (const commit of event.commits) {
      numbers.push(...parseMergeCommitPrNumbers(commit?.message));
    }
  }

  return unique(numbers).filter((number) => Number.isSafeInteger(number) && number > 0);
}

export function collectProductionValidationPrNumbers({ baseline = "", explicit = "", event = null } = {}) {
  return unique([
    ...parseOptionalPrNumbers(baseline),
    ...parseOptionalPrNumbers(explicit),
    ...prNumbersFromGithubEvent(event),
  ]);
}

function parseArgs(argv) {
  const args = {
    baseline: process.env.PRODUCTION_VALIDATION_BASELINE_PR_NUMBERS ?? "",
    explicit: process.env.PRODUCTION_VALIDATION_PR_NUMBERS ?? "",
    eventPath: process.env.GITHUB_EVENT_PATH ?? "",
    output: "",
  };
  for (const arg of argv) {
    const [name, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (name === "--baseline") args.baseline = value;
    if (name === "--explicit") args.explicit = value;
    if (name === "--event-path") args.eventPath = value;
    if (name === "--output") args.output = value;
  }
  return args;
}

async function readEvent(eventPath) {
  if (!eventPath) return null;
  const text = (await readFile(eventPath, "utf8")).trim();
  if (!text) return null;
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const event = await readEvent(args.eventPath);
  const prNumbers = collectProductionValidationPrNumbers({
    baseline: args.baseline,
    explicit: args.explicit,
    event,
  });
  const value = prNumbers.join(",");
  if (args.output) {
    await writeFile(args.output, `pr_numbers=${value}\n`, { flag: "a" });
  }
  console.log(value);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
