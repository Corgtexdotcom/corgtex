#!/usr/bin/env tsx
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  exactTargetInventoryWorkloadClasses,
  evaluateExactTargetInventoryJson,
  type ExactTargetInventoryWorkloadClass,
} from "@corgtex/domain/exact-target-inventory";

const args = process.argv.slice(2);
const classSet = new Set<string>(exactTargetInventoryWorkloadClasses);

const closed = (code: string, status = 2): never => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(status);
};

const canonicalInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

const parseArgs = (tokens: readonly string[]): {
  readonly fileArg: string;
  readonly requested?: ExactTargetInventoryWorkloadClass;
  readonly now: string;
} => {
  if (tokens.length === 0 || tokens[0]?.startsWith("-")) closed("MISSING_FILE");
  const fileArg = tokens[0] as string;
  let requested: ExactTargetInventoryWorkloadClass | undefined;
  let now: string | undefined;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("--class=")) {
      const value = token.slice("--class=".length);
      if (requested !== undefined || !classSet.has(value)) closed("INVALID_CLASS");
      requested = value as ExactTargetInventoryWorkloadClass;
    } else if (token.startsWith("--now=")) {
      const value = token.slice("--now=".length);
      if (now !== undefined || !canonicalInstant(value)) closed("INVALID_NOW");
      now = value;
    } else {
      closed("INVALID_ARGS");
    }
  }
  return { fileArg, ...(requested === undefined ? {} : { requested }), now: now ?? new Date().toISOString() };
};

const { fileArg, requested, now } = parseArgs(args);

try {
  const filePath = resolve(fileArg);
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > EXACT_TARGET_INVENTORY_MAX_BYTES) closed("READ_FAILED");
  const inputText = readFileSync(filePath, "utf8");
  const result = evaluateExactTargetInventoryJson(inputText, { now, requestedWorkloadClass: requested });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
} catch {
  closed("READ_FAILED");
}
