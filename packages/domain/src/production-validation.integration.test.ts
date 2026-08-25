import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import {
  PR976_ACTION_GOAL_OPERATION_KEY,
  PR976_SYNTHETIC_MARKER,
  PR976_TARGET_PULL_REQUEST,
  PR976_TARGET_RELEASE_SHA,
} from "./production-validation";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables();
});

async function createValidationWorkspace() {
  return prisma.workspace.create({
    data: {
      slug: "corgtex-validation",
      name: "Corgtex Validation",
    },
  });
}

describe("ProductionValidationReceipt integration", () => {
  it("enforces a durable one-time operation claim in PostgreSQL", async () => {
    const workspace = await createValidationWorkspace();
    await prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "1".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    });

    await expect(prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "2".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    })).rejects.toMatchObject({ code: "P2002" });

    await expect(prisma.productionValidationReceipt.count({
      where: { operationKey: PR976_ACTION_GOAL_OPERATION_KEY },
    })).resolves.toBe(1);
  });

  it("cascades only with the owning validation workspace", async () => {
    const workspace = await createValidationWorkspace();
    await prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "1".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    });

    await prisma.workspace.delete({ where: { id: workspace.id } });
    await expect(prisma.productionValidationReceipt.count()).resolves.toBe(0);
  });
});
