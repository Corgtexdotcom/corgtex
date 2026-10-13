import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveKnowledgeAccessDomains } from "./brain-access";

const prisma = getPrismaClient();

async function fixture(explicitFlag: boolean) {
  const user = await prisma.user.create({ data: {
    email: `finance-proof-${crypto.randomUUID()}@example.test`, displayName: "Synthetic reader", passwordHash: "test",
  } });
  const workspace = await prisma.workspace.create({ data: {
    slug: `finance-proof-${crypto.randomUUID()}`, name: "Synthetic finance proof",
  } });
  const member = await prisma.member.create({ data: {
    userId: user.id, workspaceId: workspace.id, role: "CONTRIBUTOR", isActive: true,
  } });
  if (explicitFlag) await prisma.workspaceFeatureFlag.create({ data: {
    workspaceId: workspace.id, flag: "FINANCE", enabled: true,
  } });
  return { actor: { kind: "user", user } as AppActor, workspace, member, user };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

beforeEach(async () => { await truncateAllTables(); });

describe("Finance lineage authorization transaction fence", () => {
  it("observes a FINANCE revocation committed before the proof transaction", async () => {
    const { actor, workspace } = await fixture(true);
    await prisma.workspaceFeatureFlag.update({
      where: { workspaceId_flag: { workspaceId: workspace.id, flag: "FINANCE" } },
      data: { enabled: false },
    });
    await expect(prisma.$transaction(tx => resolveKnowledgeAccessDomains(actor, workspace.id, tx)))
      .resolves.toEqual(["WORKSPACE"]);
  });

  it("holds an existing FINANCE flag revocation until proof commits", async () => {
    const { actor, workspace } = await fixture(true);
    const entered = gate(), release = gate();
    const proof = prisma.$transaction(async tx => {
      const domains = await resolveKnowledgeAccessDomains(actor, workspace.id, tx);
      entered.open();
      await release.promise;
      return domains;
    }, { timeout: 10_000 });
    await entered.promise;
    let revoked = false;
    const revocation = prisma.workspaceFeatureFlag.update({
      where: { workspaceId_flag: { workspaceId: workspace.id, flag: "FINANCE" } },
      data: { enabled: false },
    }).then(() => { revoked = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 125));
      expect(revoked).toBe(false);
    } finally {
      release.open();
    }
    expect(await proof).toEqual(["WORKSPACE", "FINANCE"]);
    await revocation;
    await expect(prisma.$transaction(tx => resolveKnowledgeAccessDomains(actor, workspace.id, tx)))
      .resolves.toEqual(["WORKSPACE"]);
  });

  it("holds a member deactivation until proof commits", async () => {
    const { actor, workspace, member } = await fixture(true);
    const entered = gate(), release = gate();
    const proof = prisma.$transaction(async tx => {
      const domains = await resolveKnowledgeAccessDomains(actor, workspace.id, tx);
      entered.open();
      await release.promise;
      return domains;
    }, { timeout: 10_000 });
    await entered.promise;
    let deactivated = false;
    const revocation = prisma.member.update({ where: { id: member.id }, data: { isActive: false } })
      .then(() => { deactivated = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 125));
      expect(deactivated).toBe(false);
    } finally {
      release.open();
    }
    expect(await proof).toEqual(["WORKSPACE", "FINANCE"]);
    await revocation;
    await expect(prisma.$transaction(tx => resolveKnowledgeAccessDomains(actor, workspace.id, tx)))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("fences insertion of an absent disabling FINANCE flag through the Workspace foreign key", async () => {
    const { actor, workspace } = await fixture(false);
    const entered = gate(), release = gate();
    const proof = prisma.$transaction(async tx => {
      const domains = await resolveKnowledgeAccessDomains(actor, workspace.id, tx);
      entered.open();
      await release.promise;
      return domains;
    }, { timeout: 10_000 });
    await entered.promise;
    let inserted = false;
    const insertion = prisma.workspaceFeatureFlag.create({ data: {
      workspaceId: workspace.id, flag: "FINANCE", enabled: false,
    } }).then(() => { inserted = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 125));
      expect(inserted).toBe(false);
    } finally {
      release.open();
    }
    expect(await proof).toEqual(["WORKSPACE", "FINANCE"]);
    await insertion;
    await expect(prisma.$transaction(tx => resolveKnowledgeAccessDomains(actor, workspace.id, tx)))
      .resolves.toEqual(["WORKSPACE"]);
  });

  it("fences a new support restriction for a previously unrestricted member", async () => {
    const { actor, workspace, user } = await fixture(true);
    const grantor = await prisma.user.create({ data: {
      email: `finance-grantor-${crypto.randomUUID()}@example.test`, displayName: "Synthetic grantor", passwordHash: "test",
    } });
    const entered = gate(), release = gate();
    const proof = prisma.$transaction(async tx => {
      const domains = await resolveKnowledgeAccessDomains(actor, workspace.id, tx);
      entered.open();
      await release.promise;
      return domains;
    }, { timeout: 10_000 });
    await entered.promise;
    let inserted = false;
    const insertion = prisma.workspaceSupportGrant.create({ data: {
      workspaceId: workspace.id, userId: user.id, grantedByUserId: grantor.id, role: "SETUP", isActive: true,
    } }).then(() => { inserted = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 125));
      expect(inserted).toBe(false);
    } finally {
      release.open();
    }
    expect(await proof).toEqual(["WORKSPACE", "FINANCE"]);
    await insertion;
    await expect(prisma.$transaction(tx => resolveKnowledgeAccessDomains(actor, workspace.id, tx)))
      .rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
  });
});
