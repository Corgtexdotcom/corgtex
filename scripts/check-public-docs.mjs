#!/usr/bin/env node
// Keeps the public docs tree limited to Mintlify documentation pages.

import { execSync } from "node:child_process";
import path from "node:path";

const ALLOWED_TOP_LEVEL = new Set([
  "docs/.mintignore",
  "docs/architecture.mdx",
  "docs/docs.json",
  "docs/introduction.mdx",
  "docs/plans/codex-public-docs-cleanup.md",
  "docs/quickstart.mdx",
]);

const ALLOWED_DIRS = [
  "docs/contributing/",
  "docs/decide/",
  "docs/deploy/",
  "docs/know/",
  "docs/see/",
];

const ALLOWED_DIR_EXTENSIONS = new Set([".mdx"]);

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function isAllowedPublicDoc(file) {
  if (ALLOWED_TOP_LEVEL.has(file)) return true;
  if (!ALLOWED_DIRS.some((prefix) => file.startsWith(prefix))) return false;
  return ALLOWED_DIR_EXTENSIONS.has(path.extname(file));
}

function trackedDocsFiles() {
  const out = sh("git ls-files docs");
  return out ? out.split("\n").filter(Boolean) : [];
}

function changedDocsFiles() {
  const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : (process.env.BASE ?? "origin/main");
  try {
    const out = sh(`git diff --name-status ${base}...HEAD -- docs`);
    return out
      ? out.split("\n").filter(Boolean).map((line) => {
          const [status, ...parts] = line.split("\t");
          const file = parts.at(-1);
          return { status, file };
        })
      : [];
  } catch {
    return [];
  }
}

const trackedViolations = trackedDocsFiles().filter((file) => !isAllowedPublicDoc(file));
const changedViolations = changedDocsFiles()
  .filter(({ status }) => !status.startsWith("D"))
  .map(({ file }) => file)
  .filter((file) => file && !isAllowedPublicDoc(file));

const violations = [...new Set([...trackedViolations, ...changedViolations])];

if (violations.length > 0) {
  console.error(
    `check-public-docs: docs/ contains non-public or generated files:\n  - ${violations.join("\n  - ")}`,
  );
  process.exit(1);
}

console.log("check-public-docs: docs/ contains only public documentation-site files");
