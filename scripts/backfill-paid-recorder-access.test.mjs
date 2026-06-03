import { describe, expect, it, vi } from "vitest";
import {
  backfillPaidRecorderAccess,
  paidRecorderWorkspaceWhere,
  parseArgs,
} from "./backfill-paid-recorder-access.mjs";

function workspace(id, flag) {
  return {
    id,
    slug: id,
    featureFlags: flag ? [{ flag: "MEETING_RECORDERS", ...flag }] : [],
  };
}

function prismaFixture(workspaces) {
  return {
    workspace: { findMany: vi.fn().mockResolvedValue(workspaces) },
    workspaceFeatureFlag: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe("paid recorder access backfill", () => {
  it("selects active PAYG billing workspaces and dry-runs by default", async () => {
    const prisma = prismaFixture([
      workspace("ws-paid-missing"),
      workspace("ws-paid-enabled", { enabled: true }),
    ]);

    const result = await backfillPaidRecorderAccess(prisma);

    expect(prisma.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: paidRecorderWorkspaceWhere(),
      orderBy: { createdAt: "asc" },
      select: expect.objectContaining({
        featureFlags: expect.objectContaining({ where: { flag: "MEETING_RECORDERS" } }),
      }),
    }));
    expect(prisma.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, scanned: 2, targets: 1, updated: 0 });
    expect(result.workspaces).toEqual([
      expect.objectContaining({ id: "ws-paid-missing", recorderAccessEnabled: false, needsBackfill: true }),
      expect.objectContaining({ id: "ws-paid-enabled", recorderAccessEnabled: true, needsBackfill: false }),
    ]);
  });

  it("applies only missing or disabled paid recorder flags", async () => {
    const prisma = prismaFixture([
      workspace("ws-paid-disabled", { enabled: false, config: { existing: "value" } }),
      workspace("ws-paid-enabled", { enabled: true }),
    ]);

    const result = await backfillPaidRecorderAccess(prisma, { apply: true });

    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith({
      where: { workspaceId_flag: { workspaceId: "ws-paid-disabled", flag: "MEETING_RECORDERS" } },
      update: {
        enabled: true,
        config: expect.objectContaining({ existing: "value", stripePaygAiRecorderAccess: true }),
      },
      create: {
        workspaceId: "ws-paid-disabled",
        flag: "MEETING_RECORDERS",
        enabled: true,
        config: expect.objectContaining({ existing: "value", stripePaygAiRecorderAccess: true }),
      },
    });
    expect(result).toMatchObject({ dryRun: false, scanned: 2, targets: 1, updated: 1 });
  });

  it("parses apply and limit options", () => {
    expect(parseArgs(["--apply", "--limit=25"])).toEqual({ apply: true, limit: 25 });
    expect(parseArgs(["--limit", "10"])).toEqual({ apply: false, limit: 10 });
    expect(() => parseArgs(["--limit=0"])).toThrow("--limit must be a positive integer.");
  });
});
