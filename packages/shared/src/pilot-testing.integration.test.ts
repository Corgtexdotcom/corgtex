import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { createProposal, createTension, loginUserWithPassword } from "@corgtex/domain";

const prisma = new PrismaClient();
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runScript(script: string, env: Record<string, string>) {
  execFileSync(process.execPath, [resolve(rootDir, script)], {
    cwd: rootDir,
    stdio: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("pilot tester scripts", () => {
  const createdWorkspaceIds: string[] = [];

  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds.splice(0)) {
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
  });

  it("seeds a tester that can create artifacts and archive its test artifacts", async () => {
    const suffix = Date.now().toString(36);
    const workspace = await prisma.workspace.create({
      data: {
        slug: `pilot-test-${suffix}`,
        name: "Pilot Test Workspace",
      },
    });
    createdWorkspaceIds.push(workspace.id);

    const testerEmail = `tester-${suffix}@example.com`;
    const testerPassword = "pilot-test-password";

    runScript("scripts/seed-pilot-tester.mjs", {
      WORKSPACE_ID: workspace.id,
      TESTER_EMAIL: testerEmail,
      TESTER_PASSWORD: testerPassword,
    });

    const login = await loginUserWithPassword({
      email: testerEmail,
      password: testerPassword,
    });
    const actor = { kind: "user" as const, user: login.user };

    const proposal = await createProposal(actor, {
      workspaceId: workspace.id,
      title: `[TEST] Proposal ${suffix}`,
      bodyMd: "Pilot test proposal.",
    });
    const tension = await createTension(actor, {
      workspaceId: workspace.id,
      title: `[TEST] Tension ${suffix}`,
      bodyMd: "Pilot test tension.",
    });

    runScript("scripts/cleanup-test-artifacts.mjs", {
      WORKSPACE_ID: workspace.id,
      TESTER_EMAIL: testerEmail,
    });

    await expect(prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } }))
      .resolves.toMatchObject({ status: "ARCHIVED", archivedAt: expect.any(Date) });
    await expect(prisma.tension.findUniqueOrThrow({ where: { id: tension.id } }))
      .resolves.toMatchObject({ archivedAt: expect.any(Date) });

    await expect(prisma.auditLog.count({
      where: {
        workspaceId: workspace.id,
        action: "test_artifact.archived",
      },
    })).resolves.toBe(2);
    await expect(prisma.workspaceArchiveRecord.count({
      where: {
        workspaceId: workspace.id,
        entityType: { in: ["Proposal", "Tension"] },
      },
    })).resolves.toBe(2);
  });
});
