#!/usr/bin/env node
// Enforces the agent-pipeline plan contract.
//
// Modes:
//   --mode=present   — verify docs/plans/<branch>.md exists.
//   --mode=scope     — verify changed files ⊆ plan's "Files to touch" allowlist.
//   --mode=size      — verify diff is within caps (≤ 400 LOC of code, ≤ 15 files)
//                      unless the PR carries the `large-change-approved` label.
//
// Reads branch/base/labels from env (GitHub Actions) or from git/flags locally.
// Exits non-zero on violation; prints a one-line CI-friendly reason.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [[m[1], m[2]]] : [[a.replace(/^--/, ""), "true"]];
  }),
);

const mode = args.mode;
if (!["present", "scope", "size"].includes(mode)) {
  console.error("usage: check-plan.mjs --mode=<present|scope|size>");
  process.exit(2);
}

const DOCS_EXTENSIONS = new Set([".md", ".mdx"]);
const FORBIDDEN_UNLABELED_PATHS = [
  /^deploy\//,
  /^\.github\/workflows\//,
  /^prisma\/migrations\//,
  /^packages\/domain\/src\/auth.*\.ts$/,
  /^apps\/web\/lib\/auth\.ts$/,
];
const MAX_CODE_LOC = 400;
const MAX_FILES = 15;

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function branchName() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.BRANCH) return process.env.BRANCH;
  return sh("git rev-parse --abbrev-ref HEAD");
}

function baseRef() {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (process.env.BASE) return process.env.BASE;
  return "origin/main";
}

function planPathFor(branch) {
  const slug = branch.toLowerCase().replace(/\//g, "-");
  return path.join("docs", "plans", `${slug}.md`);
}

function prLabels() {
  const raw = process.env.PR_LABELS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function changedFiles(base) {
  try {
    const out = sh(`git diff --name-only ${base}...HEAD`);
    return out ? out.split("\n") : [];
  } catch (err) {
    if (process.env.GITHUB_ACTIONS === "true") {
      fail(`unable to compute changed files against ${base}: ${err.message}`);
    }
    // Fall back to uncommitted working-tree diff when running locally with no base.
    const out = sh("git diff --name-only HEAD");
    return out ? out.split("\n") : [];
  }
}

function parseAllowlist(planText) {
  // Walk the file line by line. Entries are list items under a
  // "## Files to touch" (or "### Files to touch") heading, until the
  // next heading of equal or higher level.
  const entries = [];
  let inSection = false;
  for (const line of planText.split("\n")) {
    if (/^#{2,3}\s+Files to touch\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s+\S/.test(line)) break;
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+`?([^`\s]+)`?\s*$/);
    if (m) entries.push(m[1]);
  }
  return entries;
}

function matchesAllowlist(file, allowlist) {
  for (const pattern of allowlist) {
    if (pattern === file) return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -2); // keep trailing `/`
      if (file.startsWith(prefix)) return true;
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (
        file.startsWith(prefix) &&
        !file.slice(prefix.length).includes("/")
      ) {
        return true;
      }
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (file.startsWith(prefix)) return true;
    }
  }
  return false;
}

function fail(message) {
  console.error(`check-plan(${mode}): ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`check-plan(${mode}): ${message}`);
  process.exit(0);
}

const branch = branchName();
const labels = prLabels();

if (branch === "main" || branch === "HEAD") {
  ok(`skipped on ${branch}`);
}

if (labels.has("auto-revert") && mode === "present") {
  ok("auto-revert label present, plan presence skipped");
}

const planPath = planPathFor(branch);

if (mode === "present") {
  if (!existsSync(planPath)) {
    fail(`missing plan file at ${planPath}. Copy docs/plans/_TEMPLATE.md.`);
  }
  ok(`${planPath} present`);
}

const base = baseRef();

if (mode === "scope") {
  const files = changedFiles(base);
  if (!labels.has("auto-revert")) {
    if (!existsSync(planPath)) {
      fail(`missing plan file at ${planPath}`);
    }
    const planText = readFileSync(planPath, "utf8");
    const allowlist = parseAllowlist(planText);
    if (!allowlist || allowlist.length === 0) {
      fail(`${planPath} has no "Files to touch" entries`);
    }
    const outOfScope = files.filter((f) => f && !matchesAllowlist(f, allowlist));
    if (outOfScope.length > 0) {
      fail(
        `${outOfScope.length} file(s) outside plan scope:\n  - ${outOfScope.join("\n  - ")}`,
      );
    }
  }

  const forbidden = files.filter((f) =>
    FORBIDDEN_UNLABELED_PATHS.some((re) => re.test(f)),
  );
  if (forbidden.length > 0 && !labels.has("forbidden-path-approved")) {
    fail(
      `forbidden path change without "forbidden-path-approved" label:\n  - ${forbidden.join("\n  - ")}`,
    );
  }

  ok(`${files.length} file(s) all within scope`);
}

if (mode === "size") {
  const files = changedFiles(base);
  if (labels.has("large-change-approved")) {
    ok("large-change-approved label present, size check skipped");
  }
  if (files.length > MAX_FILES) {
    fail(
      `${files.length} files changed, cap is ${MAX_FILES}. Split the PR or add "large-change-approved".`,
    );
  }
  // Count LOC of non-doc files only.
  let codeLoc = 0;
  try {
    const numstat = sh(`git diff --numstat ${base}...HEAD`);
    for (const line of numstat.split("\n")) {
      if (!line) continue;
      const [addedRaw, removedRaw, ...rest] = line.split("\t");
      const added = Number(addedRaw);
      const removed = Number(removedRaw);
      const file = rest.join("\t");
      if (!Number.isFinite(added) || !Number.isFinite(removed)) continue; // binary
      const ext = path.extname(file);
      if (DOCS_EXTENSIONS.has(ext)) continue;
      codeLoc += added + removed;
    }
  } catch (err) {
    fail(`unable to compute diff size: ${err.message}`);
  }
  if (codeLoc > MAX_CODE_LOC) {
    fail(
      `${codeLoc} LOC of code changed, cap is ${MAX_CODE_LOC}. Split the PR or add "large-change-approved".`,
    );
  }
  ok(`${files.length} file(s), ${codeLoc} code LOC within caps`);
}
