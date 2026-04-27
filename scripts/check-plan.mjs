#!/usr/bin/env node
// Enforces the agent-pipeline plan contract.
//
// Modes:
//   --mode=present   — verify the PR body contains the plan contract.
//   --mode=scope     — verify changed files ⊆ plan's "Files to touch" allowlist.
//   --mode=size      — verify diff is within risk-tier caps unless the PR carries
//                      the `large-change-approved` label.
//   --mode=policy    — verify review blockers that should be caught before Codex.
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
if (!["present", "scope", "size", "policy"].includes(mode)) {
  console.error("usage: check-plan.mjs --mode=<present|scope|size|policy>");
  process.exit(2);
}

const DOCS_EXTENSIONS = new Set([".md", ".mdx"]);
const LOCAL_PLAN_DIR = path.join(".agents", "plans");
const FORBIDDEN_UNLABELED_PATHS = [
  /^deploy\//,
  /^\.github\/workflows\//,
  /^prisma\/migrations\//,
  /^packages\/domain\/src\/auth.*\.ts$/,
  /^apps\/web\/lib\/auth\.ts$/,
];
const RISK_CAPS = {
  low: { codeLoc: 1200, files: 50 },
  standard: { codeLoc: 800, files: 25 },
  high: { codeLoc: 400, files: 15 },
};
const UI_PATHS = [
  /^apps\/web\/app\//,
  /^apps\/web\/components\//,
  /^apps\/web\/lib\/components\//,
];
const DOMAIN_SOURCE = /^packages\/domain\/src\/.*\.ts$/;
const DOMAIN_TEST = /^packages\/domain\/.*\.test\.ts$/;
const PLAN_SECRET_PATTERNS = [
  { name: "private key block", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { name: "OpenSSH private key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  {
    name: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "AWS access key", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "OpenRouter API key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
  { name: "JWT-like token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

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

function branchSlug(branch) {
  return branch.toLowerCase().replace(/\//g, "-");
}

function localPlanPathFor(branch) {
  return path.join(LOCAL_PLAN_DIR, `${branchSlug(branch)}.md`);
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
    const outputs = [sh(`git diff --name-only ${base}...HEAD`)];
    if (process.env.GITHUB_ACTIONS !== "true") {
      outputs.push(sh("git diff --name-only --cached"));
      outputs.push(sh("git diff --name-only"));
    }
    return [...new Set(outputs.flatMap((out) => (out ? out.split("\n") : [])))];
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

function parseRiskTier(planText) {
  const lines = planText.split("\n");
  for (const line of lines) {
    const inline = line.match(/risk tier\s*[:—-]\s*`?(low|standard|high)`?/i);
    if (inline) return inline[1].toLowerCase();
  }

  let inSection = false;
  for (const line of lines) {
    if (/^#{2,3}\s+Risk tier\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s+\S/.test(line)) break;
    if (!inSection) continue;
    const value = line.match(/^\s*(?:[-*]\s+)?`?(low|standard|high)`?\s*$/i);
    if (value) return value[1].toLowerCase();
  }

  return null;
}

function parseAcceptanceCriteria(planText) {
  const criteria = [];
  let inSection = false;
  for (const line of planText.split("\n")) {
    if (/^#{2,3}\s+Acceptance criteria\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s+\S/.test(line)) break;
    if (!inSection) continue;
    const item = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (item) {
      criteria.push({ checked: item[1].toLowerCase() === "x", text: item[2] });
    }
  }
  return criteria;
}

function extractSection(planText, title) {
  const lines = planText.split("\n");
  const sectionHeading = new RegExp(`^#{2,3}\\s+${title}\\s*$`, "i");
  let inSection = false;
  const body = [];
  for (const line of lines) {
    if (sectionHeading.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,3}\s+\S/.test(line)) break;
    if (inSection) body.push(line);
  }
  return body.join("\n").trim();
}

function hasVisualProof(planText) {
  const section = extractSection(planText, "Visual Proof");
  if (!section) return false;
  const normalized = section
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/`[^`]*`/g, "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (/required for frontend|delete this section|link actual proof|do not commit screenshots|do not commit generated proof/.test(normalized)) {
    return false;
  }
  if (/^(n\/a|none|not applicable|delete this section if no ui paths changed)\.?$/.test(normalized)) {
    return false;
  }
  return true;
}

function planSecretFindings(planText) {
  const findings = [];
  const lines = planText.split("\n");
  for (const { name, pattern } of PLAN_SECRET_PATTERNS) {
    const lineIndex = lines.findIndex((line) => pattern.test(line));
    if (lineIndex >= 0) findings.push(`${name} on line ${lineIndex + 1}`);
  }
  return findings;
}

function assertPlanHasNoCredentialMaterial(planText) {
  const secretFindings = planSecretFindings(planText);
  if (secretFindings.length > 0) {
    fail(`plan contract appears to contain credential material:\n  - ${secretFindings.join("\n  - ")}`);
  }
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

function isUiFile(file) {
  return UI_PATHS.some((re) => re.test(file));
}

function isDomainSourceFile(file) {
  return DOMAIN_SOURCE.test(file) && !DOMAIN_TEST.test(file);
}

function isEnvFile(file) {
  return /(^|\/)\.env($|[.\w-])/.test(file);
}

function isExecutablePolicyFile(file) {
  if (/^(scripts|deploy|\.github\/workflows)\//.test(file)) return true;
  if (/Dockerfile$/.test(file)) return true;
  return [".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".json"].includes(
    path.extname(file),
  );
}

function addedDiffLines(base) {
  const outputs = [sh(`git diff --unified=0 --no-ext-diff ${base}...HEAD`)];
  if (process.env.GITHUB_ACTIONS !== "true") {
    outputs.push(sh("git diff --unified=0 --no-ext-diff --cached"));
    outputs.push(sh("git diff --unified=0 --no-ext-diff"));
  }
  const out = outputs.filter(Boolean).join("\n");
  const lines = [];
  let currentFile = "";
  for (const line of out.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    lines.push({ file: currentFile, text: line.slice(1) });
  }
  return lines;
}

function fail(message) {
  console.error(`check-plan(${mode}): ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`check-plan(${mode}): ${message}`);
  process.exit(0);
}

function readPlanText(branch) {
  const prBody = process.env.PR_BODY?.trim();
  if (prBody) return prBody;

  const localPlanPath = localPlanPathFor(branch);
  if (existsSync(localPlanPath)) {
    return readFileSync(localPlanPath, "utf8");
  }

  fail(
    `missing plan contract. Put the plan in the PR body, or create ignored local file ${localPlanPath} for local checks.`,
  );
}

const branch = branchName();
const labels = prLabels();

if (branch === "main" || branch === "HEAD") {
  ok(`skipped on ${branch}`);
}

if (labels.has("auto-revert") && mode === "present") {
  ok("auto-revert label present, plan presence skipped");
}

if (mode === "present") {
  const planText = readPlanText(branch);
  assertPlanHasNoCredentialMaterial(planText);
  if (!parseRiskTier(planText)) {
    fail("plan contract is missing a valid risk tier of low, standard, or high");
  }
  const allowlist = parseAllowlist(planText);
  if (!allowlist || allowlist.length === 0) {
    fail('plan contract has no "Files to touch" entries');
  }
  ok("plan contract present in PR body or ignored local plan file");
}

const base = baseRef();

if (mode === "scope") {
  const files = changedFiles(base);
  if (!labels.has("auto-revert")) {
    const planText = readPlanText(branch);
    assertPlanHasNoCredentialMaterial(planText);
    const allowlist = parseAllowlist(planText);
    if (!allowlist || allowlist.length === 0) {
      fail('plan contract has no "Files to touch" entries');
    }
    const outOfScope = files.filter(
      (f) => f && !matchesAllowlist(f, allowlist),
    );
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
  const planText = readPlanText(branch);
  assertPlanHasNoCredentialMaterial(planText);
  const riskTier = parseRiskTier(planText);
  if (!riskTier) {
    fail("plan contract is missing a valid risk tier of low, standard, or high");
  }
  const forbidden = files.filter((f) =>
    FORBIDDEN_UNLABELED_PATHS.some((re) => re.test(f)),
  );
  const effectiveRiskTier = forbidden.length > 0 ? "high" : riskTier;
  const caps = RISK_CAPS[effectiveRiskTier];

  if (files.length > caps.files) {
    fail(
      `${files.length} files changed, ${effectiveRiskTier} risk cap is ${caps.files}. Split the PR or add "large-change-approved".`,
    );
  }
  // Count LOC of non-doc files only.
  let codeLoc = 0;
  try {
    const numstats = [sh(`git diff --numstat ${base}...HEAD`)];
    if (process.env.GITHUB_ACTIONS !== "true") {
      numstats.push(sh("git diff --numstat --cached"));
      numstats.push(sh("git diff --numstat"));
    }
    for (const line of numstats.filter(Boolean).join("\n").split("\n")) {
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
  if (codeLoc > caps.codeLoc) {
    fail(
      `${codeLoc} LOC of code changed, ${effectiveRiskTier} risk cap is ${caps.codeLoc}. Split the PR or add "large-change-approved".`,
    );
  }
  ok(`${files.length} file(s), ${codeLoc} code LOC within ${effectiveRiskTier} risk caps`);
}

if (mode === "policy") {
  if (labels.has("auto-revert")) {
    ok("auto-revert label present, policy skipped");
  }

  const files = changedFiles(base);
  const planText = readPlanText(branch);
  assertPlanHasNoCredentialMaterial(planText);
  const riskTier = parseRiskTier(planText);
  if (!riskTier) {
    fail("plan contract is missing a valid risk tier of low, standard, or high");
  }

  const envFiles = files.filter(isEnvFile);
  if (envFiles.length > 0) {
    fail(`environment file changes are forbidden:\n  - ${envFiles.join("\n  - ")}`);
  }

  const domainSourceChanged = files.some(isDomainSourceFile);
  const domainTestChanged = files.some((f) => DOMAIN_TEST.test(f));
  if (domainSourceChanged && !domainTestChanged) {
    fail("packages/domain source changed without a packages/domain *.test.ts change");
  }

  const uiChanged = files.some(isUiFile);
  if (uiChanged && !hasVisualProof(planText)) {
    fail('UI files changed; add a non-empty "Visual Proof" section to the PR body with proof links or CI artifact references');
  }

  if (process.env.PR_DRAFT !== "true") {
    const criteria = parseAcceptanceCriteria(planText);
    if (criteria.length === 0) {
      fail("plan contract has no acceptance criteria checklist");
    }
    const unticked = criteria.filter((criterion) => !criterion.checked);
    if (unticked.length > 0) {
      fail(
        `ready PR has unticked acceptance criteria:\n  - ${unticked
          .map((criterion) => criterion.text)
          .join("\n  - ")}`,
      );
    }
  }

  const patternHits = [];
  for (const { file, text } of addedDiffLines(base)) {
    if (file === "scripts/check-plan.mjs") continue;
    if (/--no-verify/.test(text) && isExecutablePolicyFile(file)) {
      patternHits.push(`${file}: added --no-verify`);
    }
    if (/prisma\s+db\s+push/.test(text) && isExecutablePolicyFile(file)) {
      patternHits.push(`${file}: added prisma db push`);
    }
    if (/--admin/.test(text) && isExecutablePolicyFile(file) && !labels.has("force-merge")) {
      patternHits.push(`${file}: added --admin without force-merge label`);
    }
  }
  if (patternHits.length > 0) {
    fail(`forbidden diff pattern(s):\n  - ${patternHits.join("\n  - ")}`);
  }

  ok(`${riskTier} risk policy checks passed`);
}
