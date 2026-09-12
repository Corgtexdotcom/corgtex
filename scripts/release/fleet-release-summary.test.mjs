import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fleetReleaseSummary } from "./fleet-release-summary.mjs";

describe("fleet release summary", () => {
  const success = { DRY_RUN_INPUT: "false", PROMOTION_VERIFIED: "true", PREFLIGHT_OUTCOME: "success", PROMOTION_OUTCOME: "success", OBSERVATION_OUTCOME: "success" };
  it("never calls a successful dry run a verified release", () => {
    const result = fleetReleaseSummary({ ...success, DRY_RUN_INPUT: "true" });
    expect(result.verified).toBe(false);
    expect(result.summary).toContain("DRY RUN ONLY");
    expect(result.summary).toContain("No provider promotion occurred");
  });
  it("identifies failed preflight during a dry run", () => {
    expect(fleetReleaseSummary({ DRY_RUN_INPUT: "true", PREFLIGHT_OUTCOME: "failure" }).summary).toContain("DRY RUN FAILED");
  });
  it("requires completed promotion and observation for selected-target proof", () => {
    expect(fleetReleaseSummary(success)).toMatchObject({ verified: true, summary: expect.stringContaining("RELEASE VERIFIED") });
  });
  it.each([
    { PROMOTION_OUTCOME: "failure" }, { PROMOTION_OUTCOME: "skipped" },
    { OBSERVATION_OUTCOME: "failure" }, { OBSERVATION_OUTCOME: "skipped" },
    { PROMOTION_VERIFIED: "false" }, { PROMOTION_VERIFIED: "" },
  ])("does not overclaim incomplete or partially failed releases: %j", (change) => {
    expect(fleetReleaseSummary({ ...success, ...change })).toMatchObject({ verified: false, summary: expect.stringContaining("RELEASE NOT VERIFIED") });
  });
  it("runs the summary even on failure and consumes actual step outcomes", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/fleet-release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("PROMOTION_VERIFIED: ${{ steps.promotion.outputs.promotion_verified }}");
    expect(workflow).toContain("OBSERVATION_OUTCOME: ${{ steps.observation.outcome }}");
    expect(workflow).toContain("name: Summarize release evidence\n        if: ${{ always() }}");
    expect(workflow).toContain('cp scripts/release/fleet-release-summary.mjs "$RUNNER_TEMP/fleet-release-summary.mjs"');
    expect(workflow).toContain('node "$RUNNER_TEMP/fleet-release-summary.mjs"');
  });
});
