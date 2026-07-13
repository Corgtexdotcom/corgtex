#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const artifactDir = join(".artifacts", "repo-cleanliness");
mkdirSync(artifactDir, { recursive: true });

const mode = process.argv.includes("--locals-only")
  ? "locals"
  : process.argv.includes("--knip-only")
    ? "knip"
    : "all";

function runReport(name, command, args, outputFile) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });

  const output = [
    `# ${name}`,
    `started_at=${startedAt}`,
    `exit_code=${result.status ?? "signal:" + result.signal}`,
    "",
    "## stdout",
    result.stdout || "",
    "",
    "## stderr",
    result.stderr || "",
  ].join("\n");

  writeFileSync(join(artifactDir, outputFile), output);

  if (result.error) {
    throw result.error;
  }

  return {
    name,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    output: join(artifactDir, outputFile),
  };
}

const reports = [];

if (mode === "all" || mode === "knip") {
  reports.push(
    runReport("knip compact report", "npx", [
      "knip",
      "--no-progress",
      "--no-exit-code",
      "--reporter",
      "compact",
    ], "knip-compact.txt"),
    runReport("knip json report", "npx", [
      "knip",
      "--no-progress",
      "--no-exit-code",
      "--reporter",
      "json",
    ], "knip.json"),
  );
}

if (mode === "all" || mode === "locals") {
  reports.push(
    runReport("typescript unused locals", "npx", [
      "tsc",
      "-p",
      "tsconfig.unused.json",
      "--noEmit",
      "--incremental",
      "false",
    ], "tsconfig-unused.txt"),
  );
}

writeFileSync(
  join(artifactDir, "summary.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`,
);

console.log(`Repo cleanliness reports written to ${artifactDir}`);
for (const report of reports) {
  console.log(`- ${report.name}: exit=${report.exitCode ?? report.signal} ${report.output}`);
}
