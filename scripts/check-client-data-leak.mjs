/**
 * Client Data Leak Prevention Check
 *
 * Scans committed source files for patterns that indicate private client
 * data has been accidentally committed to the public repo.
 *
 * Uses `git grep` for performance (searches git index, not filesystem).
 *
 * Exit code 0 = clean, exit code 1 = leak detected.
 */

import { execSync } from "node:child_process";

// ─── Client identifiers that MUST NOT appear in source code ───
// Add new client names here as they are onboarded.
const BLOCKED_PATTERNS = [
  "crina",
  "vilassarenca",
  "sleepcare",
  "seed-crina",
  "seed-industrial",
];

// ─── Files that are allowed to reference client names ───
const ALLOWLISTED_PATHS = [
  "scripts/check-client-data-leak.mjs",
  ".gitignore",
  "AGENTS.md",
];

function main() {
  const violations = [];

  for (const pattern of BLOCKED_PATTERNS) {
    try {
      const result = execSync(
        `git grep -inl "${pattern}" -- '*.ts' '*.tsx' '*.mjs' '*.js' '*.json' '*.yml' '*.yaml' '*.css' '*.sh' '*.md'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const files = result.trim().split("\n").filter(Boolean);
      for (const file of files) {
        if (ALLOWLISTED_PATHS.some((a) => file.startsWith(a))) continue;
        // Get the matching lines for context
        try {
          const lines = execSync(
            `git grep -in "${pattern}" -- "${file}"`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          ).trim();
          violations.push({ file, pattern, lines });
        } catch {
          violations.push({ file, pattern, lines: "(match found)" });
        }
      }
    } catch {
      // git grep returns exit code 1 when no matches — that's the happy path
    }
  }

  if (violations.length === 0) {
    console.log("✅ Client data leak check passed — no blocked patterns found.");
    process.exit(0);
  }

  console.error("❌ CLIENT DATA LEAK DETECTED");
  console.error("═".repeat(60));
  console.error("The following files contain blocked client identifiers.");
  console.error("Client-specific data MUST NOT be committed to this repo.");
  console.error("Use environment variables (CLIENT_SEED_CONFIG_JSON) instead.");
  console.error("═".repeat(60));
  console.error("");

  for (const v of violations) {
    console.error(`  📁 ${v.file}  [pattern: "${v.pattern}"]`);
    for (const line of v.lines.split("\n").slice(0, 3)) {
      console.error(`     ${line}`);
    }
    console.error("");
  }

  const uniqueFiles = new Set(violations.map((v) => v.file));
  console.error(`Total: ${violations.length} violation(s) in ${uniqueFiles.size} file(s).`);
  process.exit(1);
}

main();
