#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = result.stdout.trim() || result.stderr.trim();
  if (!output) return { ok: result.status === 0, data: null, status: result.status ?? 1 };
  try {
    return { ok: result.status === 0, data: JSON.parse(output), status: result.status ?? 1 };
  } catch {
    return { ok: false, data: null, status: result.status ?? 1, error: output.slice(0, 1000) };
  }
}

function parseMajor(version) {
  const match = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function classifyUpdate(current, latest) {
  const from = parseMajor(current);
  const to = parseMajor(latest);
  if (!from || !to) return "unknown";
  if (to.major > from.major) return "major";
  if (to.minor > from.minor) return "minor";
  if (to.patch > from.patch) return "patch";
  return "same";
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "corgtex-nightly-research/1.0",
        accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, data: null };
    }
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: null, data: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function dependencySummary() {
  const outdated = runJson("npm", ["outdated", "--json"]);
  const packages = outdated.data && typeof outdated.data === "object"
    ? Object.entries(outdated.data).map(([name, info]) => ({
      name,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest,
      type: classifyUpdate(info.current, info.latest),
    }))
    : [];

  const counts = packages.reduce(
    (acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    },
    {},
  );

  return { packages, counts, commandStatus: outdated.status };
}

function auditSummary() {
  const audit = runJson("npm", ["audit", "--json", "--omit=dev"]);
  const vulnerabilities = audit.data?.metadata?.vulnerabilities ?? {};
  return {
    commandStatus: audit.status,
    vulnerabilities,
    advisories: Object.entries(audit.data?.vulnerabilities ?? {}).map(([name, value]) => ({
      name,
      severity: value.severity,
      via: Array.isArray(value.via) ? value.via.length : 0,
      fixAvailable: Boolean(value.fixAvailable),
    })),
  };
}

function defaultGithubQueries() {
  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [
    `topic:model-context-protocol stars:>500 pushed:>${since}`,
    `topic:ai-agents stars:>1000 pushed:>${since}`,
    `topic:rag stars:>1000 pushed:>${since}`,
    `topic:workflow-automation stars:>1000 pushed:>${since}`,
  ];
}

function configuredGithubQueries() {
  const raw = process.env.NIGHTLY_RESEARCH_GITHUB_QUERIES_JSON?.trim();
  if (!raw) return defaultGithubQueries();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("NIGHTLY_RESEARCH_GITHUB_QUERIES_JSON must be an array.");
  return parsed.map(String);
}

async function githubScout(skipNetwork) {
  if (skipNetwork) return [];
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const results = [];
  for (const query of configuredGithubQueries()) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`;
    const response = await fetchJson(url, { headers });
    results.push({
      query,
      ok: response.ok,
      status: response.status,
      repositories: (response.data?.items ?? []).map((repo) => ({
        fullName: repo.full_name,
        description: repo.description,
        stars: repo.stargazers_count,
        pushedAt: repo.pushed_at,
        url: repo.html_url,
      })),
    });
  }
  return results;
}

async function modelScout(skipNetwork) {
  if (skipNetwork) return [];
  const scouts = [];
  const openRouter = await fetchJson("https://openrouter.ai/api/v1/models");
  scouts.push({
    provider: "openrouter",
    ok: openRouter.ok,
    status: openRouter.status,
    models: (openRouter.data?.data ?? []).slice(0, 12).map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length,
    })),
  });

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    const openai = await fetchJson("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${openAiKey}` },
    });
    scouts.push({
      provider: "openai",
      ok: openai.ok,
      status: openai.status,
      models: (openai.data?.data ?? []).slice(0, 20).map((model) => ({ id: model.id, created: model.created })),
    });
  } else {
    scouts.push({ provider: "openai", ok: false, status: "skipped", models: [], note: "OPENAI_API_KEY not configured" });
  }
  return scouts;
}

function table(rows, columns) {
  if (rows.length === 0) return "_None._\n";
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "").replace(/\n/g, " ")).join(" | ")} |`);
  return [header, divider, ...body].join("\n") + "\n";
}

function renderReport(report) {
  const lines = [
    "# Nightly Research and Upgrade Scout",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Dependency Drift",
    "",
    `- Patch updates: ${report.dependencies.counts.patch ?? 0}`,
    `- Minor updates: ${report.dependencies.counts.minor ?? 0}`,
    `- Major updates: ${report.dependencies.counts.major ?? 0}`,
    `- Unknown updates: ${report.dependencies.counts.unknown ?? 0}`,
    "",
    table(report.dependencies.packages.slice(0, 20), [
      { label: "Package", value: (row) => row.name },
      { label: "Current", value: (row) => row.current },
      { label: "Wanted", value: (row) => row.wanted },
      { label: "Latest", value: (row) => row.latest },
      { label: "Type", value: (row) => row.type },
    ]),
    "## Security Audit",
    "",
    ...Object.entries(report.audit.vulnerabilities).map(([severity, count]) => `- ${severity}: ${count}`),
    "",
    table(report.audit.advisories.slice(0, 20), [
      { label: "Package", value: (row) => row.name },
      { label: "Severity", value: (row) => row.severity },
      { label: "Via", value: (row) => row.via },
      { label: "Fix", value: (row) => row.fixAvailable ? "available" : "manual" },
    ]),
    "## Model Watch",
    "",
  ];

  for (const scout of report.models) {
    lines.push(`### ${scout.provider}`, "");
    if (!scout.ok) {
      lines.push(`Unavailable: ${scout.note ?? scout.status ?? "unknown"}`, "");
      continue;
    }
    lines.push(table(scout.models, [
      { label: "Model", value: (row) => row.id },
      { label: "Name", value: (row) => row.name ?? "" },
      { label: "Context", value: (row) => row.contextLength ?? "" },
    ]));
  }

  lines.push("## Open Source Scout", "");
  for (const scout of report.github) {
    lines.push(`### ${scout.query}`, "");
    if (!scout.ok) {
      lines.push(`Unavailable: ${scout.status ?? "unknown"}`, "");
      continue;
    }
    lines.push(table(scout.repositories, [
      { label: "Repository", value: (row) => `[${row.fullName}](${row.url})` },
      { label: "Stars", value: (row) => row.stars },
      { label: "Pushed", value: (row) => row.pushedAt },
      { label: "Description", value: (row) => row.description ?? "" },
    ]));
  }

  lines.push(
    "## Suggested Routing",
    "",
    "- High or critical security findings should become fix PRs before feature work.",
    "- Patch and minor dependency updates can be grouped into normal automated PRs when tests pass.",
    "- Major dependency updates, new models, and new OSS integrations should become proposal/demo issues first.",
    "- No speculative feature should auto-merge from this report.",
    "",
  );

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(String(args["out-dir"] || ".artifacts/nightly-research"));
  const skipNetwork = Boolean(args["skip-network"]);
  mkdirSync(outDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    dependencies: dependencySummary(),
    audit: auditSummary(),
    models: await modelScout(skipNetwork),
    github: await githubScout(skipNetwork),
  };

  const markdown = renderReport(report);
  writeFileSync(path.join(outDir, "report.md"), markdown);
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(`Wrote ${path.join(outDir, "report.md")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

