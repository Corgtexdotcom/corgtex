#!/usr/bin/env tsx
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXACT_TARGET_INVENTORY_MAX_BYTES,
  exactTargetInventoryWorkloadClasses,
  evaluateExactTargetInventoryJson,
  type ExactTargetInventoryWorkloadClass,
} from "@corgtex/domain/exact-target-inventory";

const args = process.argv.slice(2);
const classSet = new Set<string>(exactTargetInventoryWorkloadClasses);

const closed = (code: string, status = 2): void => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = status;
};

const canonicalInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

const parseArgs = (tokens: readonly string[], defaultNow: string): {
  readonly fileArg: string;
  readonly requested?: ExactTargetInventoryWorkloadClass;
  readonly now: string;
} | null => {
  if (tokens.length === 0 || tokens[0]?.startsWith("-")) {
    closed("MISSING_FILE");
    return null;
  }
  const fileArg = tokens[0] as string;
  let requested: ExactTargetInventoryWorkloadClass | undefined;
  let now: string | undefined;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("--class=")) {
      const value = token.slice("--class=".length);
      if (requested !== undefined || !classSet.has(value)) {
        closed("INVALID_CLASS");
        return null;
      }
      requested = value as ExactTargetInventoryWorkloadClass;
    } else if (token.startsWith("--now=")) {
      const value = token.slice("--now=".length);
      if (now !== undefined || !canonicalInstant(value)) {
        closed("INVALID_NOW");
        return null;
      }
      now = value;
    } else {
      closed("INVALID_ARGS");
      return null;
    }
  }
  return { fileArg, ...(requested === undefined ? {} : { requested }), now: now ?? defaultNow };
};

const readExactTargetInventoryFile = (fileArg: string): string | null => {
  let fd: number | null = null;
  try {
    const filePath = resolve(fileArg);
    fd = openSync(filePath, constants.O_RDONLY);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > EXACT_TARGET_INVENTORY_MAX_BYTES) return null;
    const buffer = Buffer.allocUnsafe(EXACT_TARGET_INVENTORY_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) return buffer.subarray(0, offset).toString("utf8");
      offset += bytesRead;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The CLI has already failed closed; close errors must not leak local state.
      }
    }
  }
};

const parsed = parseArgs(args, new Date().toISOString());

if (parsed) {
  const { fileArg, requested, now } = parsed;
  const inputText = readExactTargetInventoryFile(fileArg);
  if (inputText === null) {
    closed("READ_FAILED");
  } else {
    const result = evaluateExactTargetInventoryJson(inputText, { now, requestedWorkloadClass: requested });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
