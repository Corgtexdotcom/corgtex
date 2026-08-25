#!/usr/bin/env tsx
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  evaluateExactTargetInventoryJson,
  type ExactTargetInventoryWorkloadClass,
} from "@corgtex/domain";

const args = process.argv.slice(2);
const fileArg = args[0];
const requested = args.find((arg) => arg.startsWith("--class="))?.slice("--class=".length) as ExactTargetInventoryWorkloadClass | undefined;
const now = args.find((arg) => arg.startsWith("--now="))?.slice("--now=".length) ?? new Date().toISOString();

const closed = (code: string, status = 2): never => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(status);
};

if (fileArg === undefined || fileArg.startsWith("-")) closed("MISSING_FILE");

try {
  const filePath = resolve(fileArg);
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > EXACT_TARGET_INVENTORY_MAX_BYTES) closed("READ_FAILED");
  const inputText = readFileSync(filePath, "utf8");
  const result = evaluateExactTargetInventoryJson(inputText, { now, requestedWorkloadClass: requested });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.artifactStatus === "VALID" ? 0 : 1);
} catch {
  closed("READ_FAILED");
}
