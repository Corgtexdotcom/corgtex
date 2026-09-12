import { describe, expect, it } from "vitest";
import { buildHostingImageReceipt } from "./hosting-image-receipt.mjs";

const input = {
  repository: "Example/Project",
  gitSha: "a".repeat(40),
  runId: "123",
  runAttempt: "1",
  siteDigest: `sha256:${"b".repeat(64)}`,
  monitorDigest: `sha256:${"c".repeat(64)}`,
};

describe("hosting image publication receipts", () => {
  it("binds deployment references to published digests and the exact workflow attempt", () => {
    const receipt = buildHostingImageReceipt(input);
    expect(receipt.sourceCommit).toBe(input.gitSha);
    expect(receipt.workflowRun.url).toBe("https://github.com/Example/Project/actions/runs/123/attempts/1");
    expect(receipt.images.site.reference).toBe(`ghcr.io/example/project/site@${input.siteDigest}`);
    expect(receipt.images.monitor.reference).toBe(`ghcr.io/example/project/ops-monitor@${input.monitorDigest}`);
  });
  it("does not conflate different builds of the same source commit", () => {
    const first = buildHostingImageReceipt(input);
    const second = buildHostingImageReceipt({ ...input, runAttempt: "2", siteDigest: `sha256:${"d".repeat(64)}` });
    expect(second.sourceCommit).toBe(first.sourceCommit);
    expect(second.images.site.reference).not.toBe(first.images.site.reference);
    expect(second.workflowRun).not.toEqual(first.workflowRun);
  });
  it.each([undefined, "", `sha-${"b".repeat(40)}`, `sha256:${"z".repeat(64)}`])("rejects missing or non-digest publish output %s", (siteDigest) => {
    expect(() => buildHostingImageReceipt({ ...input, siteDigest })).toThrow("Invalid published site digest");
  });
});
