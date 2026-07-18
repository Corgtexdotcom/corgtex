import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { shortHash } from "./ops-core.mjs";

const githubIncidentPath = fileURLToPath(new URL("./github-incident.mjs", import.meta.url));
const healthSweepPath = fileURLToPath(new URL("./health-sweep.mjs", import.meta.url));

describe("github-incident resolved issue sync", () => {
  it("closes resolved ops-auto-fix issues while leaving active issues open", async () => {
    const activeToken = opsToken("active-dedupe");
    const resolvedToken = opsToken("resolved-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, ["--sync-resolved"], [
      {
        dedupeKey: "active-dedupe",
        severity: "P2",
        service: "agents",
        status: "agentFailureStreak",
        summary: "Acme has repeated inbox-triage agent failures",
      },
    ], {
      issues: [
        issue(1, `[${activeToken}] P2 agents: active`),
        issue(2, `[${resolvedToken}] P2 agents: resolved`),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues.find((item) => item.number === 1).closed).toBeFalsy();
    expect(result.state.issues.find((item) => item.number === 2)).toMatchObject({
      closed: true,
      closeReason: "completed",
    });
    expect(result.state.issues.find((item) => item.number === 2).closeComment).toContain("Resolved by clean ops sweep");
  });

  it("does not close incidents blocked by human-control labels", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, ["--sync-resolved"], [], {
      issues: [
        issue(3, `[${staleToken}] P2 control-plane: needs replan`, ["ops-auto-fix", "needs-replan"]),
        issue(4, `[${staleToken}] P2 web: halted`, ["ops-auto-fix", "halt-agents"]),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues.every((item) => !item.closed)).toBe(true);
  });

  it("requires explicit incident input when resolved sync is requested", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, ["--sync-resolved"], null, {
      issues: [issue(7, `[${staleToken}] P2 web: stale`)],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--sync-resolved requires explicit incident JSON");
    expect(result.state.issues[0].closed).toBeFalsy();
  });

  it("rejects empty incident files when resolved sync is requested", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, ["--sync-resolved"], null, {
      fileContent: "  \n",
      issues: [issue(7, `[${staleToken}] P2 web: stale`)],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--sync-resolved requires explicit incident JSON");
    expect(result.state.issues[0].closed).toBeFalsy();
  });

  it("scopes resolved sync to matching dedupe prefixes", async () => {
    const controlPlaneToken = opsToken("control-plane:deployment-1:slackInvalidAuth");
    const readinessToken = opsToken("client-readiness:example-client:smoke:1:none");
    const result = await runWithFakeGh(githubIncidentPath, [
      "--sync-resolved",
      "--sync-dedupe-prefixes",
      "control-plane:",
    ], [], {
      issues: [
        issue(
          8,
          `[${controlPlaneToken}] P2 slack: stale`,
          ["ops-auto-fix"],
          "control-plane:deployment-1:slackInvalidAuth",
        ),
        issue(
          9,
          `[${readinessToken}] P2 client: readiness still owned elsewhere`,
          ["ops-auto-fix"],
          "client-readiness:example-client:smoke:1:none",
        ),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues.find((item) => item.number === 8).closed).toBe(true);
    expect(result.state.issues.find((item) => item.number === 9).closed).toBeFalsy();
  });

  it("uses bounded paged gh api issue listing for resolved sync", async () => {
    const issues = Array.from({ length: 101 }, (_, index) => {
      const dedupeKey = `resolved-dedupe-${index + 1}`;
      const labels = index < 100 ? ["ops-auto-fix", "ops-incident", "halt-agents"] : ["ops-auto-fix", "ops-incident"];
      return issue(index + 10, `[${opsToken(dedupeKey)}] P2 web: stale ${index + 1}`, labels, dedupeKey);
    });
    const result = await runWithFakeGh(githubIncidentPath, ["--sync-resolved"], [], {
      issues,
    });

    expect(result.code, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      calls: result.state.calls,
    }, null, 2)).toBe(0);
    expect(result.state.issues.slice(0, 100).every((item) => !item.closed)).toBe(true);
    expect(result.state.issues[100].closed).toBe(true);
    const apiCalls = result.state.calls.filter((call) => call[0] === "api" && call.includes("repos/{owner}/{repo}/issues"));
    expect(apiCalls.length).toBe(2);
    expect(apiCalls[0]).toContain("page=1");
    expect(apiCalls[1]).toContain("page=2");
  });

  it("leaves open issues untouched when resolved sync is not requested", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, [], [], {
      issues: [issue(5, `[${staleToken}] P2 web: stale`)],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues[0].closed).toBeFalsy();
    expect(result.state.calls.some((call) => call[0] === "issue" && call[1] === "list")).toBe(false);
  });

  it("dedupes advisory ops incidents that are not builder auto-fix work", async () => {
    const dedupeKey = "observation:azure_monitor:corgtex_worker_error:corgtex:tick:WORKER_TICK_ERROR:old-release";
    const advisoryToken = opsToken(dedupeKey);
    const result = await runWithFakeGh(githubIncidentPath, [], [
      {
        dedupeKey,
        severity: "P2",
        service: "post-deploy-observation",
        status: "advisory",
        summary: "Unrelated production worker error",
      },
    ], {
      issues: [
        issue(16, `[${advisoryToken}] P2 post-deploy-observation: Unrelated production worker error`, ["ops-advisory", "ops-incident"], dedupeKey),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues).toHaveLength(1);
    expect(result.state.issues[0].comments[0]).toContain("Repeated signal");
    expect(result.state.calls).toContainEqual(expect.arrayContaining(["issue", "list", "--label", "ops-incident"]));
    expect(result.state.calls.some((call) => call[0] === "issue" && call[1] === "create")).toBe(false);
  });

  it("runs resolved sync from clean health sweeps that create issues", async () => {
    const server = await startHealthServer();
    try {
      const staleDedupe = `site:${server.url}/api/health:down`;
      const staleToken = opsToken(staleDedupe);
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        issues: [issue(6, `[${staleToken}] P2 site: stale`, ["ops-auto-fix"], staleDedupe)],
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: "site",
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "",
          CONTROL_PLANE_URL: "",
          APP_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.state.issues[0].closed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("normalizes health target prefixes before resolved sync", async () => {
    const server = await startHealthServer();
    try {
      const staleDedupe = `site prod:${server.url}/api/health:down`;
      const staleToken = opsToken(staleDedupe);
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        issues: [issue(12, `[${staleToken}] P2 site: stale`, ["ops-auto-fix"], staleDedupe)],
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: "site   prod",
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "",
          CONTROL_PLANE_URL: "",
          APP_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.state.issues[0].closed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("truncates health target prefixes to match stored incident dedupe keys", async () => {
    const server = await startHealthServer();
    try {
      const targetName = `site-${"x".repeat(220)}`;
      const normalizedDedupe = `${targetName}:${server.url}/api/health:down`.slice(0, 200).toLowerCase();
      const staleToken = opsToken(normalizedDedupe);
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        issues: [issue(14, `[${staleToken}] P2 site: stale`, ["ops-auto-fix"], normalizedDedupe)],
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: targetName,
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "",
          CONTROL_PLANE_URL: "",
          APP_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.state.issues[0].closed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("keeps comma-bearing health target prefixes intact during resolved sync", async () => {
    const server = await startHealthServer();
    try {
      const staleDedupe = `site,prod:${server.url}/api/health:down`;
      const staleToken = opsToken(staleDedupe);
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        issues: [issue(15, `[${staleToken}] P2 site: stale`, ["ops-auto-fix"], staleDedupe)],
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: "site,prod",
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "",
          CONTROL_PLANE_URL: "",
          APP_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.state.issues[0].closed).toBe(true);
      const syncCall = result.state.calls.find((call) => call[0] === "api");
      expect(syncCall).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("does not enable control-plane resolved sync for invalid control-plane URLs", async () => {
    const server = await startHealthServer();
    try {
      const staleDedupe = "control-plane:deployment-1:slackInvalidAuth";
      const staleToken = opsToken(staleDedupe);
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        issues: [issue(13, `[${staleToken}] P2 slack: stale`, ["ops-auto-fix"], staleDedupe)],
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: "site",
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "configured",
          CONTROL_PLANE_URL: "not-a-url",
          APP_URL: "",
          OPS_CONTROL_PLANE_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.state.issues[0].closed).toBeFalsy();
    } finally {
      await server.close();
    }
  });

  it("does not fail clean health sweeps when resolved sync fails", async () => {
    const server = await startHealthServer();
    try {
      const result = await runWithFakeGh(healthSweepPath, [], null, {
        failIssueList: true,
        env: {
          OPS_CREATE_GITHUB_ISSUES: "true",
          OPS_HEALTH_TARGETS_JSON: JSON.stringify([
            {
              name: "site",
              service: "site",
              url: `${server.url}/api/health`,
              expectJson: { status: "ok" },
            },
          ]),
          CONTROL_PLANE_AGENT_API_KEY: "",
          CONTROL_PLANE_URL: "",
          APP_URL: "",
          NEXT_PUBLIC_APP_URL: "",
          NEXT_PUBLIC_SITE_URL: "",
          OPS_PRIMARY_CLIENT_URL: "",
        },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Resolved issue sync failed during a clean sweep");
    } finally {
      await server.close();
    }
  });
});

function opsToken(dedupeKey) {
  return `ops:${shortHash(dedupeKey, 10)}`;
}

function issue(number, title, labels = ["ops-auto-fix"], dedupeKey = null) {
  return {
    number,
    title,
    body: dedupeKey ? ["## Routing", "", `- Dedupe key: ${dedupeKey}`].join("\n") : "",
    labels: labels.map((name) => ({ name })),
  };
}

async function runWithFakeGh(scriptPath, args, input, options = {}) {
  const tmp = await mkdtemp(path.join(tmpdir(), "corgtex-gh-incident-"));
  const statePath = path.join(tmp, "state.json");
  const ghPath = path.join(tmp, "fake-gh.mjs");
  await writeFile(statePath, JSON.stringify({
    issues: options.issues ?? [],
    calls: [],
    failIssueList: Boolean(options.failIssueList),
    issueListLimit: options.issueListLimit ?? null,
  }));
  await writeFile(ghPath, fakeGhSource());
  await chmod(ghPath, 0o755);
  const resolvedArgs = [...args];
  if (Object.hasOwn(options, "fileContent")) {
    const inputPath = path.join(tmp, "input.json");
    await writeFile(inputPath, options.fileContent);
    resolvedArgs.push("--file", inputPath);
  }

  try {
    const output = await runNodeScript(scriptPath, resolvedArgs, input, {
      ...process.env,
      ...(options.env ?? {}),
      GH_BIN: ghPath,
      GH_FAKE_STATE: statePath,
      GITHUB_TOKEN: "",
      OPS_GITHUB_TOKEN: "",
      GITHUB_REPOSITORY: "",
      OPS_GITHUB_REPOSITORY: "",
    });
    return {
      code: output.code,
      stdout: output.stdout,
      stderr: output.stderr,
      state: JSON.parse(await readFile(statePath, "utf8")),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runNodeScript(scriptPath, args, input, env) {
  const child = spawn(process.execPath, [scriptPath, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (input === null) {
    child.stdin.end();
  } else {
    child.stdin.end(JSON.stringify(input));
  }
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

function fakeGhSource() {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);
state.calls.push(argv);

function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

function output(text) {
  writeFileSync(1, String(text) + "\\n");
}

function argValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

if (argv[0] === "label" && argv[1] === "create") {
  save();
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "list") {
  if (state.failIssueList) {
    console.error("simulated issue list failure");
    save();
    process.exit(1);
  }
  const search = argValue("--search");
  const token = search ? search.split(" ")[0] : null;
  const issues = token
    ? state.issues.filter((issue) => issue.title.includes(token))
    : state.issues.filter((issue) => !issue.closed);
  const limitedIssues = state.issueListLimit ? issues.slice(0, state.issueListLimit) : issues;
  save();
  output(JSON.stringify(limitedIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
  }))));
  process.exit(0);
}

if (argv[0] === "api" && argv.includes("repos/{owner}/{repo}/issues")) {
  if (state.failIssueList) {
    console.error("simulated issue list failure");
    save();
    process.exit(1);
  }
  const pageArg = argv.find((arg) => arg.startsWith("page="));
  const page = pageArg ? Number(pageArg.split("=")[1]) : 1;
  const perPageArg = argv.find((arg) => arg.startsWith("per_page="));
  const perPage = perPageArg ? Number(perPageArg.split("=")[1]) : 100;
  const effectivePerPage = state.issueListLimit ?? perPage;
  const issues = state.issues
    .filter((issue) => !issue.closed)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      pull_request: issue.pull_request,
    }));
  const start = (page - 1) * effectivePerPage;
  save();
  output(JSON.stringify(issues.slice(start, start + effectivePerPage)));
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "comment") {
  const number = Number(argv[2]);
  const issue = state.issues.find((item) => item.number === number);
  if (issue) issue.comments = [...(issue.comments ?? []), argValue("--body")];
  save();
  output("https://github.test/comment");
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "create") {
  const number = Math.max(0, ...state.issues.map((issue) => issue.number)) + 1;
  const labels = String(argValue("--label") ?? "").split(",").filter(Boolean).map((name) => ({ name }));
  state.issues.push({ number, title: argValue("--title"), labels });
  save();
  output("https://github.test/issues/" + number);
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "close") {
  const number = Number(argv[2]);
  const issue = state.issues.find((item) => item.number === number);
  if (issue) {
    issue.closed = true;
    issue.closeReason = argValue("--reason");
    issue.closeComment = argValue("--comment");
  }
  save();
  output("closed");
  process.exit(0);
}

console.error("unexpected gh call: " + argv.join(" "));
save();
process.exit(1);
`;
}

async function startHealthServer() {
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
