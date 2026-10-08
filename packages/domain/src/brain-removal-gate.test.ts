import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { isBrainSourceRemovalEnabled, isBrainSourceRemovalRuntimeEnabled,
  requireBrainSourceRemovalEnabled } from "./brain-removal-gate";

const key = "BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED";
const original = process.env[key];

afterEach(() => {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
});

describe("Brain source removal runtime gate", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true ", "true\n"])(
    "fails closed for runtime value %s even when the stored flag is true", async (value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      const findUnique = vi.fn().mockResolvedValue({ enabled: true });
      const queryRaw = vi.fn().mockResolvedValue([{ enabled: true }]);
      const db = { workspaceFeatureFlag: { findUnique }, $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
      expect(isBrainSourceRemovalRuntimeEnabled()).toBe(false);
      expect(await isBrainSourceRemovalEnabled(db, "workspace-a")).toBe(false);
      await expect(requireBrainSourceRemovalEnabled(db, "workspace-a"))
        .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
      expect(findUnique).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, null])("requires the stored flag with explicit runtime opt-in: %s", async (stored) => {
    process.env[key] = "true";
    const findUnique = vi.fn().mockResolvedValue(stored === null ? null : { enabled: stored });
    const queryRaw = vi.fn().mockResolvedValue(stored === null ? [] : [{ enabled: stored }]);
    const db = { workspaceFeatureFlag: { findUnique }, $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
    expect(isBrainSourceRemovalRuntimeEnabled()).toBe(true);
    expect(await isBrainSourceRemovalEnabled(db, "workspace-a")).toBe(stored === true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId_flag: { workspaceId: "workspace-a", flag: "BRAIN_SOURCE_REMOVAL" } },
      select: { enabled: true },
    });
    if (stored === true) await expect(requireBrainSourceRemovalEnabled(db, "workspace-a")).resolves.toBeUndefined();
    else await expect(requireBrainSourceRemovalEnabled(db, "workspace-a"))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
