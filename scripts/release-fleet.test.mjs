import { describe, expect, it, vi } from "vitest";

import { buildWorkflowInputs, runFleetReleaseDispatch, workflowForInputs } from "./release-fleet.mjs";

const SHA = "c9077ff031e8e672923c84d52eeef862368f3493";

describe("release fleet command", () => {
  it("defaults to latest-stable and all target groups", () => {
    expect(buildWorkflowInputs(["--reason", "Ship latest stable."])).toMatchObject({
      release: "latest-stable",
      targets: "railway-customers,azure-selfserve,ops,backup-app",
      reason: "Ship latest stable.",
      dryRun: false,
      concurrency: 2,
      forceAfterFailure: false,
      watch: true,
      ref: "main",
    });
  });

  it("validates explicit SHA and target groups", () => {
    expect(buildWorkflowInputs([
      "--release",
      SHA,
      "--targets",
      "ops,backup-app",
      "--dry-run",
      "--reason",
      "Plan release.",
      "--no-watch",
    ])).toMatchObject({
      release: SHA,
      targets: "ops,backup-app",
      dryRun: true,
      watch: false,
    });
  });

  it("uses the lightweight preflight workflow for dry runs", () => {
    expect(workflowForInputs(buildWorkflowInputs([
      "--dry-run",
      "--reason",
      "Plan latest stable.",
    ]))).toBe("fleet-release-preflight.yml");
  });

  it("dispatches the fleet release workflow through GitHub Actions", () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ stdout: "", stderr: "" })
      .mockReturnValueOnce({ stdout: JSON.stringify([{ databaseId: 123, url: "https://github.test/run/123" }]), stderr: "" })
      .mockReturnValueOnce({ stdout: "", stderr: "" });

    runFleetReleaseDispatch(["--release", SHA, "--reason", "Deploy latest."], { runCommand });

    expect(runCommand).toHaveBeenNthCalledWith(1, "gh", expect.arrayContaining([
      "workflow",
      "run",
      "fleet-release.yml",
      "-f",
      `release=${SHA}`,
    ]));
    expect(runCommand).toHaveBeenNthCalledWith(2, "gh", expect.arrayContaining([
      "--workflow",
      "fleet-release.yml",
    ]));
    expect(runCommand).toHaveBeenNthCalledWith(3, "gh", ["run", "watch", "123", "--exit-status"], { stdio: "inherit" });
  });

  it("dispatches dry runs to the preflight workflow without release-only inputs", () => {
    const runCommand = vi.fn().mockReturnValue({ stdout: "", stderr: "" });

    runFleetReleaseDispatch(["--release", SHA, "--reason", "Plan latest.", "--dry-run", "--no-watch"], { runCommand });

    expect(runCommand).toHaveBeenCalledTimes(1);
    const args = runCommand.mock.calls[0][1];
    expect(args).toContain("fleet-release-preflight.yml");
    expect(args).toContain(`release=${SHA}`);
    expect(args).toContain("concurrency=2");
    expect(args).not.toContain("dry_run=true");
    expect(args).not.toContain("force_after_failure=false");
  });
});
