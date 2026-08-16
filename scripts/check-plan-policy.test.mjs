import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const metadata = readFileSync(
  ".github/workflows/pr-policy-metadata.yml",
  "utf8",
);

function jobBlock(source, jobId) {
  const marker = `  ${jobId}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing job: ${jobId}`);
  const tail = source.slice(start + marker.length);
  const next = tail.search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? tail : tail.slice(0, next);
}

test("legacy required-check aliases run only where PR policy runs", () => {
  const eventGuard =
    "if: ${{ always() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}";

  for (const jobId of [
    "plan-present-compat",
    "scope-check-compat",
    "diff-size-compat",
  ]) {
    const block = jobBlock(ci, jobId);
    assert.match(block, /needs: pr-policy/);
    assert.ok(block.includes(eventGuard));
    assert.doesNotMatch(block, /^\s*if: always\(\)$/m);
  }
});

test("metadata policy covers the mutable contract event matrix", () => {
  assert.match(metadata, /^\s*pull_request_target:\s*$/m);
  const types = metadata.match(/^\s*types:\s*\[([^\]]+)\]/m);
  assert.ok(types, "missing pull_request_target activity types");
  const actual = types[1].split(",").map((value) => value.trim()).sort();
  const expected = [
    "converted_to_draft",
    "edited",
    "labeled",
    "ready_for_review",
    "unlabeled",
  ].sort();
  assert.deepEqual(actual, expected);
  assert.match(
    metadata,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.match(metadata, /cp scripts\/check-plan\.mjs .*trusted-check-plan\.mjs/);
});

test("queue removal uses the pull-request ID and confirms the result", () => {
  assert.match(
    metadata,
    /pullRequest\(number:\$number\)\{id mergeQueueEntry\{id\}\}/,
  );
  assert.match(metadata, /-F id="\$pr_id"/);
  assert.doesNotMatch(metadata, /-F id="\$entry_id"/);
  assert.match(metadata, /for attempt in 1 2 3/);
  assert.match(metadata, /if \[ -z "\$current_entry_id" \]/);
  assert.match(metadata, /Unable to confirm removal/);
});
