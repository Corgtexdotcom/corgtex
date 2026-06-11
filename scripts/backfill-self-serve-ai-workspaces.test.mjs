import { describe, expect, it, vi } from "vitest";
import {
  SELF_SERVE_AI_WORKSPACE_FLAGS,
  backfillSelfServeAiWorkspaces,
  parseArgs,
  selfServeAiWorkspaceWhere,
} from "./backfill-self-serve-ai-workspaces.mjs";

function workspace(id, flags = []) {
  return {
    id,
    slug: id,
    featureFlags: flags.map((flag) => ({ enabled: true, ...flag })),
  };
}

function prismaFixture(workspaces) {
  return {
    workspace: { findMany: vi.fn().mockResolvedValue(workspaces) },
    workspaceFeatureFlag: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe("self-serve AI workspace backfill", () => {
  it("selects active trial workspaces and dry-runs by default", async () => {
    const now = new Date("2026-06-11T15:00:00.000Z");
    const prisma = prismaFixture([
      workspace("ws-missing", []),
      workspace("ws-enabled", SELF_SERVE_AI_WORKSPACE_FLAGS.map((flag) => ({ flag }))),
    ]);

    const result = await backfillSelfServeAiWorkspaces(prisma, { now });

    expect(prisma.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: selfServeAiWorkspaceWhere(now),
      orderBy: { createdAt: "asc" },
      select: expect.objectContaining({
        featureFlags: expect.objectContaining({
          where: { flag: { in: SELF_SERVE_AI_WORKSPACE_FLAGS } },
        }),
      }),
    }));
    expect(prisma.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, scanned: 2, targets: 1, updated: 0 });
    expect(result.workspaces).toEqual([
      { id: "ws-missing", slug: "ws-missing", missingFlags: SELF_SERVE_AI_WORKSPACE_FLAGS },
      { id: "ws-enabled", slug: "ws-enabled", missingFlags: [] },
    ]);
  });

  it("applies only missing or disabled AI workspace flags", async () => {
    const prisma = prismaFixture([
      workspace("ws-disabled", [
        { flag: "AI_WORKSPACES", enabled: false },
        { flag: "OPENWORK_DEFAULT", enabled: true },
      ]),
    ]);

    const result = await backfillSelfServeAiWorkspaces(prisma, { apply: true });

    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith({
      where: { workspaceId_flag: { workspaceId: "ws-disabled", flag: "AI_WORKSPACES" } },
      update: { enabled: true },
      create: { workspaceId: "ws-disabled", flag: "AI_WORKSPACES", enabled: true },
    });
    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith({
      where: { workspaceId_flag: { workspaceId: "ws-disabled", flag: "EXECUTION_PACKETS" } },
      update: { enabled: true },
      create: { workspaceId: "ws-disabled", flag: "EXECUTION_PACKETS", enabled: true },
    });
    expect(result).toMatchObject({ dryRun: false, scanned: 1, targets: 1, updated: 2 });
  });

  it("parses apply and limit options", () => {
    expect(parseArgs(["--apply", "--limit=25"])).toEqual({ apply: true, limit: 25 });
    expect(parseArgs(["--limit", "10"])).toEqual({ apply: false, limit: 10 });
    expect(() => parseArgs(["--limit=0"])).toThrow("--limit must be a positive integer.");
  });
});
