import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("leaves open issues untouched when resolved sync is not requested", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(githubIncidentPath, [], [], {
      issues: [issue(5, `[${staleToken}] P2 web: stale`)],
    });

    expect(result.code).toBe(0);
    expect(result.state.issues[0].closed).toBeFalsy();
    expect(result.state.calls.some((call) => call[0] === "issue" && call[1] === "list")).toBe(false);
  });

  it("runs resolved sync from clean health sweeps that create issues", async () => {
    const staleToken = opsToken("stale-dedupe");
    const result = await runWithFakeGh(healthSweepPath, [], null, {
      issues: [issue(6, `[${staleToken}] P2 slack: stale`)],
      env: {
        OPS_CREATE_GITHUB_ISSUES: "true",
        OPS_HEALTH_TARGETS_JSON: "[]",
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
  });
});

function opsToken(dedupeKey) {
  return `ops:${shortHash(dedupeKey, 10)}`;
}

function issue(number, title, labels = ["ops-auto-fix"]) {
  return {
    number,
    title,
    labels: labels.map((name) => ({ name })),
  };
}

async function runWithFakeGh(scriptPath, args, input, options = {}) {
  const tmp = await mkdtemp(path.join(tmpdir(), "corgtex-gh-incident-"));
  const statePath = path.join(tmp, "state.json");
  const ghPath = path.join(tmp, "fake-gh.mjs");
  await writeFile(statePath, JSON.stringify({ issues: options.issues ?? [], calls: [] }));
  await writeFile(ghPath, fakeGhSource());
  await chmod(ghPath, 0o755);

  try {
    const output = await runNodeScript(scriptPath, args, input, {
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

function argValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

if (argv[0] === "label" && argv[1] === "create") {
  save();
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "list") {
  const search = argValue("--search");
  const token = search ? search.split(" ")[0] : null;
  const issues = token
    ? state.issues.filter((issue) => issue.title.includes(token))
    : state.issues.filter((issue) => !issue.closed);
  save();
  console.log(JSON.stringify(issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
  }))));
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "comment") {
  const number = Number(argv[2]);
  const issue = state.issues.find((item) => item.number === number);
  if (issue) issue.comments = [...(issue.comments ?? []), argValue("--body")];
  save();
  console.log("https://github.test/comment");
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "create") {
  const number = Math.max(0, ...state.issues.map((issue) => issue.number)) + 1;
  const labels = String(argValue("--label") ?? "").split(",").filter(Boolean).map((name) => ({ name }));
  state.issues.push({ number, title: argValue("--title"), labels });
  save();
  console.log("https://github.test/issues/" + number);
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
  console.log("closed");
  process.exit(0);
}

console.error("unexpected gh call: " + argv.join(" "));
save();
process.exit(1);
`;
}
