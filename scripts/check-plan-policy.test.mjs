import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const metadata = readFileSync(
  ".github/workflows/pr-policy-metadata.yml",
  "utf8",
);

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
      "ready_for_review",
      "unlabeled",
    ].sort();
    expect(actual).toEqual(expected);
    expect(metadata).toMatch(
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    );
    expect(metadata).toMatch(
      /cp scripts\/check-plan\.mjs .*trusted-check-plan\.mjs/,
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
});
