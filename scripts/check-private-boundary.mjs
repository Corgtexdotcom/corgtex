import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "node_modules",
]);

const forbiddenPathRules = [
  {
    name: "private stable seed",
    test: (file) => /^scripts\/seed-.+-stable\.mjs$/.test(file) && file !== "scripts/seed-client-stable.mjs",
  },
  {
    name: "private brain seed",
    test: (file) => /^scripts\/seed-.+-brain\.mjs$/.test(file),
  },
  {
    name: "private seed directory",
    test: (file) => file.startsWith(".private-seeds/") || file.startsWith("private-seeds/"),
  },
  {
    name: "public docs artifact",
    test: (file) => /^docs\/(assets|pr-assets|plans|partner-analysis)\//.test(file),
  },
];

function gitLsFiles(args) {
  return execFileSync("git", ["ls-files", "-z", ...args], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const absolute = path.join(dir, entry);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walk(absolute, output);
    } else if (stats.isFile()) {
      output.push(relative);
    }
  }
  return output;
}

function loadAllowlist() {
  const file = path.join(root, "config", "public-customer-allowlist.json");
  if (!existsSync(file)) return new Set();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return new Set(Array.isArray(parsed.allowedTerms) ? parsed.allowedTerms.map(String) : []);
}

function loadPrivateTerms() {
  const terms = [];
  const fromEnv = process.env.PRIVATE_CUSTOMER_TERMS?.trim();
  if (fromEnv) {
    terms.push(...fromEnv.split(",").map((term) => term.trim()).filter(Boolean));
  }

  const localTermsFile = path.join(root, ".private-customer-terms");
  if (existsSync(localTermsFile)) {
    terms.push(...readFileSync(localTermsFile, "utf8")
      .split("\n")
      .map((term) => term.trim())
      .filter((term) => term && !term.startsWith("#")));
  }

  return [...new Set(terms)];
}

function isTextFile(file) {
  return /\.(cjs|css|env|js|json|jsx|md|mdx|mjs|prisma|sh|sql|toml|ts|tsx|txt|yaml|yml)$/.test(file);
}

const allFiles = walk(root);
const trackedFiles = gitLsFiles([]);
const stagedFiles = gitLsFiles(["--cached"]);
const allowlist = loadAllowlist();
const privateTerms = loadPrivateTerms().filter((term) => !allowlist.has(term));

const findings = [];

for (const file of allFiles) {
  for (const rule of forbiddenPathRules) {
    if (rule.test(file)) {
      findings.push(`${rule.name}: ${file}`);
    }
  }
}

for (const file of [...new Set([...trackedFiles, ...stagedFiles])]) {
  if (!isTextFile(file)) continue;
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) continue;
  const content = readFileSync(absolute, "utf8");
  for (const term of privateTerms) {
    if (content.toLowerCase().includes(term.toLowerCase())) {
      findings.push(`private customer term "${term}" appears in ${file}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`check-private-boundary: private/customer artifacts found in public repo:\n  - ${findings.join("\n  - ")}`);
  process.exit(1);
}

console.log("check-private-boundary: public repo boundary is clean");
