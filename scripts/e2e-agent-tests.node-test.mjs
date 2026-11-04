import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ACCEPTANCE_CASES, createReport } from "./lib/e2e-agent-report.mjs";

const runner = fileURLToPath(new URL("./e2e-agent-tests.mjs", import.meta.url));
const preload = fileURLToPath(
  new URL("./test-support/e2e-agent-synthetic.mjs", import.meta.url),
);
const total = Object.values(ACCEPTANCE_CASES).flat().length;

function run(scenario, flags = [], env = {}) {
  // Deliberately do not inherit application environment or credentials.
  const result = spawnSync(
    process.execPath,
    ["--import", preload, runner, "http://offline.invalid", ...flags],
    {
      env: {
        AGENT_API_KEY: "synthetic",
        ADMIN_EMAIL: "synthetic@example.invalid",
        ADMIN_PASSWORD: "synthetic",
        E2E_SYNTHETIC_SCENARIO: scenario,
        ...env,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}

function assertCases(output, count = total) {
  const results = [
    ...output.matchAll(/^  (PASS|FAIL|SKIP) \[([^\]]+\/[^\]]+)\]/gm),
  ];
  assert.equal(results.length, count, output);
  assert.equal(new Set(results.map((result) => result[2])).size, count, output);
}

for (const flags of [[], ["--strict"]]) {
  test(`real runner passes complete synthetic coverage: ${flags.join() || "developer"}`, () => {
    const result = run("pass", flags);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Results: 30 passed, 0 failed, 0 skipped/);
    assertCases(result.output);
    assert.match(result.output, /SYNTHETIC_REQUEST DELETE .*\/documents\/d/);
  });

  for (const scenario of ["500", "503", "401", "malformed", "network"]) {
    test(`real runner fails attempted upload ${scenario}: ${flags.join() || "developer"}`, () => {
      const result = run(scenario, flags);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Results: 27 passed, 1 failed, 2 skipped/);
      assert.doesNotMatch(
        result.output,
        /storage not configured|Missing fixture prerequisite: storage/,
      );
      assertCases(result.output);
      assert.match(
        result.output,
        /SYNTHETIC_REQUEST DELETE .*\/brain\/articles\//,
      );
      if (scenario !== "network")
        assert.match(result.output, /FAIL \[File Upload\/upload\]/);
      else
        assert.match(
          result.output,
          /FAIL \[File Upload\/upload\] Suite error: synthetic network failure/,
        );
    });
  }

  test(`explicit missing storage prerequisite: ${flags.join() || "developer"}`, () => {
    const result = run("no-storage-request", [...flags, "--without-storage"]);
    assert.equal(
      result.status,
      flags.includes("--strict") ? 1 : 0,
      result.output,
    );
    assert.match(result.output, /Results: 27 passed, 0 failed, 3 skipped/);
    assert.match(
      result.output,
      /SKIP \[File Upload\/upload\] Missing fixture prerequisite/,
    );
    assert.doesNotMatch(result.output, /SYNTHETIC_REQUEST POST .*\/documents/);
    assertCases(result.output);
  });
}

for (const scenario of ["bootstrap-500", "bootstrap-network"]) {
  test(`bootstrap abort reports every remaining case: ${scenario}`, () => {
    const result = run(scenario, ["--strict"]);
    assert.equal(result.status, 1, result.output);
    assertCases(result.output);
    assert.match(result.output, /SKIP \[Brain Articles\/status\] Not run/);
    assert.doesNotMatch(result.output, /SYNTHETIC_REQUEST POST/);
  });
}

for (const key of ["AGENT_API_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
  test(`missing ${key} fails before requests and reports coverage`, () => {
    const result = run("pass", ["--strict"], { [key]: "" });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      new RegExp(`Missing fixture prerequisites: ${key}`),
    );
    assert.match(result.output, /Results: 0 passed, 1 failed, 30 skipped/);
    assertCases(result.output);
    assert.doesNotMatch(result.output, /SYNTHETIC_REQUEST/);
  });
}

test("early suite return distinguishes failed case from blocked coverage", () => {
  const result = run("missing-document", ["--strict"]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /PASS \[File Upload\/upload\]/);
  assert.match(result.output, /FAIL \[File Upload\/listing\]/);
  assert.match(result.output, /SKIP \[File Upload\/brain-source\] Blocked/);
  assertCases(result.output);
});

test("FAILED worker status cannot pass the summary acceptance case", () => {
  const result = run("failed-worker", ["--strict"]);
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /FAIL \[Meeting Minutes\/summary-agent\].*Expected COMPLETED, got FAILED/,
  );
  assertCases(result.output);
});

test("unknown flags fail closed instead of silently disabling strict acceptance", () => {
  const result = run("pass", ["--strcit"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /Usage:/);
  assert.doesNotMatch(result.output, /SYNTHETIC_REQUEST/);
});

for (const strict of [false, true]) {
  test(`report terminal statuses and unrun cases (${strict ? "strict" : "developer"})`, () => {
    const logs = [];
    const report = createReport({ strict, log: (line) => logs.push(line) });
    report.record("Auth", "health", "pass", "synthetic pass");
    report.record("Auth", "agent-session", "fail", "synthetic failure");
    report.finishSuite("Auth", "missing fixture");
    const result = report.summary();
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, total - 2);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.cases.every((entry) =>
        ["pass", "fail", "skip"].includes(entry.status),
      ),
      true,
    );
    assert.match(logs.join("\n"), /PASS.*\n.*FAIL.*\n.*SKIP/);
  });

  test(`zero executed coverage (${strict ? "strict" : "developer"})`, () => {
    const report = createReport({ strict, log: () => {} });
    const result = report.summary();
    assert.equal(result.exitCode, strict ? 1 : 0);
    assert.equal(result.skipped, total);
  });
}

test("report rejects unknown IDs, duplicate results and invalid statuses", () => {
  const report = createReport({ log: () => {} });
  assert.throws(() => report.record("Auth", "typo", "pass", ""), /Invalid/);
  assert.throws(
    () => report.record("Auth", "health", "pending", ""),
    /Invalid/,
  );
  report.record("Auth", "health", "pass", "");
  assert.throws(() => report.record("Auth", "health", "skip", ""), /duplicate/);
});
