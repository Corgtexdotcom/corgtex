import { beforeEach, describe, expect, it } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureDemoLead } from "./crm";
import {
  createExternalDataSource,
  deleteExternalDataSource,
  enqueueExternalDataSourceSync,
  updateExternalDataSource,
} from "./integrations";
import { purgeWorkspaceArtifact } from "./archive";

const prisma = getPrismaClient();

async function createAdminActor(): Promise<{ actor: AppActor; workspaceId: string }> {
  const workspace = await prisma.workspace.create({
    data: {
      slug: "integration-workspace",
      name: "Integration Workspace",
    },
  });

  const user = await prisma.user.create({
    data: {
      email: "admin@example.com",
      displayName: "Admin",
      passwordHash: "test-password-hash",
    },
  });

  await prisma.member.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
      isActive: true,
    },
  });

  return {
    actor: {
      kind: "user",
      user,
    },
    workspaceId: workspace.id,
  };
}

beforeEach(async () => {
  await truncateAllTables();
});

describe("database-backed domain integration", () => {
  it("captures demo leads idempotently and records repeat visits", async () => {
    await captureDemoLead({ email: "Demo.User@example.com" });
    await captureDemoLead({ email: "demo.user@example.com" });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "corgtex" },
    });

    const demoLead = await prisma.demoLead.findUniqueOrThrow({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email: "demo.user@example.com",
        },
      },
    });

    const contacts = await prisma.crmContact.findMany({
      where: {
        workspaceId: workspace.id,
        email: "demo.user@example.com",
      },
    });

    expect(demoLead.visitCount).toBe(2);
    expect(demoLead.source).toBe("demo_gate");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].company).toBe("example.com");
  });

  it("manages external data source writes and persisted cleanup through domain services", async () => {
    const { actor, workspaceId } = await createAdminActor();

    const source = await createExternalDataSource(actor, {
      workspaceId,
      label: "Warehouse",
      driverType: "postgres",
      connectionStringEnc: "encrypted-connection-1",
      selectedTables: ["public.accounts"],
      pullCadenceMinutes: 60,
      cursorColumn: "updated_at",
    });

    const updated = await updateExternalDataSource(actor, {
      workspaceId,
      sourceId: source.id,
      label: "Warehouse replica",
      connectionStringEnc: "encrypted-connection-2",
      selectedTables: ["public.accounts", "public.orders"],
      pullCadenceMinutes: 30,
      cursorColumn: "modified_at",
      isActive: false,
    });

    expect(updated.label).toBe("Warehouse replica");
    expect(updated.selectedTables).toEqual(["public.accounts", "public.orders"]);
    expect(updated.isActive).toBe(false);

    const job = await enqueueExternalDataSourceSync(actor, {
      workspaceId,
      sourceId: source.id,
    });

    expect(job.type).toBe("data-source.sync");
    expect(job.workspaceId).toBe(workspaceId);
    expect(job.payload).toEqual({ sourceId: source.id });

    await prisma.knowledgeChunk.create({
      data: {
        workspaceId,
        sourceType: "EXTERNAL_DATABASE",
        sourceId: `byodb:${source.id}:public.accounts:1`,
        content: "Persisted external row",
      },
    });

    await deleteExternalDataSource(actor, {
      workspaceId,
      sourceId: source.id,
    });

    const archived = await prisma.externalDataSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.isActive).toBe(false);
    await expect(prisma.knowledgeChunk.count({ where: { workspaceId } })).resolves.toBe(1);

    await purgeWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "ExternalDataSource",
      entityId: source.id,
      reason: "Integration cleanup purge.",
    });

    await expect(prisma.externalDataSource.findUnique({ where: { id: source.id } })).resolves.toBeNull();
    await expect(prisma.knowledgeChunk.count({ where: { workspaceId } })).resolves.toBe(0);
  });
});
