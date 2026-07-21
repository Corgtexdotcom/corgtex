import { afterEach, describe, expect, it, vi } from "vitest";

import {
  upsertPracticeFinanceFixturesWithClient,
  validationPracticeFinanceFixtures,
  validationSeedConfig,
} from "./seed-internal-validation-workspace.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("internal validation workspace seed", () => {
  it("enables the native Practice Ledger routes used by production client-readiness proof", () => {
    expect(validationSeedConfig.featureFlags).toMatchObject({
      FINANCE: true,
      PRACTICE_PROJECTS: true,
    });
  });

  it("defines stable synthetic Practice Ledger fixtures for Finance Clients proof", () => {
    expect(validationPracticeFinanceFixtures.client).toMatchObject({
      code: "VAL-CLIENT",
      name: "Validation Fixture Client",
      sourceSatelliteId: "production-validation-client",
    });
    expect(validationPracticeFinanceFixtures.project).toMatchObject({
      code: "VAL-PROJECT",
      clientName: "Validation Fixture Client",
      sourceSatelliteId: "production-validation-project",
    });
    expect(validationPracticeFinanceFixtures.project.poValueCents).toBeGreaterThan(0);
  });

  it("upserts Practice Ledger fixtures with stable workspace-scoped source IDs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prisma = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ id: "workspace-1", slug: "corgtex-validation" }),
      },
      crmAccount: {
        findUnique: vi.fn().mockResolvedValue({ id: "account-1" }),
      },
      practiceClient: {
        upsert: vi.fn().mockResolvedValue({ id: "client-1" }),
      },
      practiceProject: {
        upsert: vi.fn().mockResolvedValue({ id: "project-1" }),
      },
    };

    await upsertPracticeFinanceFixturesWithClient(prisma);

    expect(prisma.practiceClient.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceSatelliteId: {
          workspaceId: "workspace-1",
          sourceSatelliteId: "production-validation-client",
        },
      },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        crmAccountId: "account-1",
        sourceSatelliteId: "production-validation-client",
      }),
    }));
    expect(prisma.practiceProject.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceSatelliteId: {
          workspaceId: "workspace-1",
          sourceSatelliteId: "production-validation-project",
        },
      },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        clientId: "client-1",
        crmAccountId: "account-1",
        sourceSatelliteId: "production-validation-project",
      }),
      update: expect.objectContaining({
        clientId: "client-1",
        crmAccountId: "account-1",
      }),
    }));
  });
});
