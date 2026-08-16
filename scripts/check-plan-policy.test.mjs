import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const metadata = readFileSync(
  ".github/workflows/pr-policy-metadata.yml",
  "utf8",
);
const checkPlanScript = path.resolve("scripts/check-plan.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "check-plan-policy-"));
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "Policy Test"]);
  git(cwd, ["config", "user.email", "policy-test@example.invalid"]);
  return cwd;
}

function commitAll(cwd, message) {
  git(cwd, ["add", "--all"]);
  git(cwd, ["commit", "--message", message]);
}

function plan({ risk = "low", files = ["README.md"] } = {}) {
  return [
    "## Goal",
    "Verify policy behavior.",
    "",
    "## Risk tier",
    risk,
    "",
    "## Files to touch",
    ...files.map((file) => `- \`${file}\``),
  ].join("\n");
}

function runPolicy(cwd, mode, env) {
  return execFileSync("node", [checkPlanScript, `--mode=${mode}`], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_BASE_REF: "",
      GITHUB_HEAD_REF: "",
      ...env,
    },
  });
}

function jobBlock(source, jobId) {
  const marker = `  ${jobId}:\n`;
  const start = source.indexOf(marker);
  expect(start, `missing job: ${jobId}`).not.toBe(-1);
  const tail = source.slice(start + marker.length);
  const next = tail.search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? tail : tail.slice(0, next);
}

describe("agent policy workflow invariants", () => {
  it("runs legacy required-check aliases only where PR policy runs", () => {
    const eventGuard =
      "if: ${{ always() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}";

    for (const jobId of [
      "plan-present-compat",
      "scope-check-compat",
      "diff-size-compat",
    ]) {
      const block = jobBlock(ci, jobId);
      expect(block).toMatch(/needs: pr-policy/);
      expect(block).toContain(eventGuard);
      expect(block).not.toMatch(/^\s*if: always\(\)$/m);
    }
  });

  it("covers the mutable contract event matrix", () => {
    expect(metadata).toMatch(/^\s*pull_request_target:\s*$/m);
    const types = metadata.match(/^\s*types:\s*\[([^\]]+)\]/m);
    expect(types, "missing pull_request_target activity types").not.toBeNull();
    const actual = types[1].split(",").map((value) => value.trim()).sort();
    const expected = [
      "converted_to_draft",
      "edited",
      "labeled",
      "opened",
      "ready_for_review",
      "reopened",
      "synchronize",
      "unlabeled",
    ].sort();
    expect(actual).toEqual(expected);
    expect(metadata).toMatch(
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    );
    expect(metadata).toMatch(
      /cp scripts\/check-plan\.mjs .*trusted-check-plan\.mjs/,
    );
    expect(metadata).toMatch(/^\s*merge_group:\s*$/m);
    expect(metadata).toMatch(
      /MERGE_GROUP_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/,
    );
    expect(metadata).toMatch(
      /statuses\/\$MERGE_GROUP_SHA[\s\S]*context="PR Metadata Policy"/,
    );
    expect(metadata).toMatch(
      /ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}/,
    );
    expect(metadata).toContain("node scripts/review-snapshot-integrity.mjs");
    expect(metadata).toContain('publish pending "Revalidating live merge-group metadata"');
    expect(metadata).toContain('publish failure "Live merge-group metadata failed policy"');
    expect(metadata).toContain('publish success "Live merge-group metadata satisfies policy"');
    expect(metadata.indexOf("node scripts/review-snapshot-integrity.mjs"))
      .toBeLessThan(metadata.indexOf('publish success "Live merge-group metadata satisfies policy"'));
    expect(metadata).toContain('contexts=("PR Metadata Policy")');
    expect(metadata).not.toMatch(
      /contexts=.*(?:"PR Policy"|"Plan Present"|"Scope Check"|"Diff Size")/,
    );
  });

  it("uses the pull-request ID and confirms queue removal", () => {
    expect(metadata).toMatch(
      /pullRequest\(number:\$number\)\{id mergeQueueEntry\{id\}\}/,
    );
    expect(metadata).toMatch(/-F id="\$pr_id"/);
    expect(metadata).not.toMatch(/-F id="\$entry_id"/);
    expect(metadata).toMatch(/for attempt in 1 2 3/);
    expect(metadata).toMatch(/if \[ -z "\$current_entry_id" \]/);
    expect(metadata).toMatch(/Unable to confirm removal/);
  });

  it("classifies both sides of a protected-file rename", () => {
    const cwd = initRepository();
    try {
      writeFileSync(path.join(cwd, "AGENTS.md"), "protected policy\n");
      commitAll(cwd, "add protected policy");
      renameSync(path.join(cwd, "AGENTS.md"), path.join(cwd, "harmless.md"));
      commitAll(cwd, "rename protected policy");

      expect(() =>
        runPolicy(cwd, "scope", {
          BASE: "HEAD^",
          BRANCH: "codex/protected-rename",
          PR_BODY: plan({ files: ["AGENTS.md", "harmless.md"] }),
          PR_DRAFT: "false",
        }),
      ).toThrow(/protected paths require critical risk:.*AGENTS\.md/s);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not replace an empty live PR body with a local draft", () => {
    const cwd = initRepository();
    try {
      writeFileSync(path.join(cwd, "README.md"), "repository\n");
      commitAll(cwd, "initialize repository");
      mkdirSync(path.join(cwd, ".agents", "plans"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".agents", "plans", "codex-empty-body.md"),
        plan(),
      );

      expect(() =>
        runPolicy(cwd, "present", {
          BRANCH: "codex/empty-body",
          PR_BODY: "",
        }),
      ).toThrow(/missing plan contract in live PR body/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
