import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const time = new Date("2026-10-12T09:00:00Z");
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND" || key === "conversation" || key === "member" || key === "account" || key === "contact" || key === "deal") return true;
    if (key === "OR") return value.some((clause: any) => match(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.in) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      return true;
    }
    return row[key] === value;
  });
  const project = (row: any, args: any): any => {
    if (!row) return null;
    let result = { ...row };
    if (args.include?.account) result.account = tables.crmAccount.find((parent) => parent.id === row.accountId) ?? null;
    if (args.include?.contact) result.contact = tables.crmContact.find((parent) => parent.id === row.contactId) ?? null;
    if (args.include?.demoLead) result.demoLead = project(tables.demoLead.find((parent) => parent.id === row.demoLeadId), args.include.demoLead === true ? {} : args.include.demoLead);
    if (args.include?.deal) result.deal = tables.crmDeal.find((parent) => parent.id === row.dealId) ?? null;
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  };
  const names = ["crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob", "crmQualificationFormInput"];
  const prisma: any = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1),
    auditLog: { create: vi.fn(async () => ({})) }, event: { createMany: vi.fn(async () => ({ count: 1 })) } };
  for (const name of names) {
    tables[name] = [];
    prisma[name] = {
      findFirst: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        return project(name === "artifactInputLineage" ? rows.at(-1) : rows[0], args);
      }),
      findUnique: vi.fn(async (args: any) => project(tables[name].find((row) => match(row, args.where)), args)),
      findMany: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        if (name === "artifactInputLineage") rows.sort((left, right) => right.revision - left.revision);
        const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : args.skip ?? 0;
        return rows.slice(start, start + (args.take ?? rows.length)).map((row) => project(row, args));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `${name}-${tables[name].length + 1}`, archivedAt: null, createdAt: time,
          ...(name === "executionRequest" ? { status: "PENDING", results: [], claimedAt: null, completedAt: null } : {}),
          ...(name !== "crmActivity" && name !== "crmDealStageTransition" ? { updatedAt: time } : {}), ...data };
        tables[name].push(row); return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = tables[name].findIndex((row) => match(row, where));
        const patched = Object.fromEntries(Object.entries(data).map(([key, value]: [string, any]) => [key, value && typeof value === "object" && "increment" in value ? tables[name][index][key] + value.increment : value]));
        tables[name][index] = { ...tables[name][index], ...patched }; return { ...tables[name][index] };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = tables[name].filter((row) => match(row, where));
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      }),
    };
  }
  prisma.crmQualification.count = vi.fn(async () => tables.crmQualification.length);
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => ({ ...row }))]));
    try { return await run(prisma); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
  });
  return { prisma, tables, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user?.id === "finance" && !fixture.revoked.has("finance")
  ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("./crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "./source-lineage";
import { listQualifications, sendSchedulingLinkEmail, submitQualification } from "./crm";
const ws = "ws-crm";
const alice = { kind: "user", user: { id: "alice", email: "alice@example.test" } } as AppActor;
const bob = { kind: "user", user: { id: "bob", email: "bob@example.test" } } as AppActor;
const form = { token: "valid-link", companyName: " Company ", website: " example.test ", roleTitle: " Owner ", aiExperience: " New ", helpNeeded: " Planning " };
const createLead = (id = "lead", workspaceId = ws) => fixture.prisma.demoLead.create({ data: { id, workspaceId,
  email: `${id}@example.test`, source: "demo_gate", qualifyToken: form.token,
  companyHint: null, utmSource: null, convertedContactId: null, followUpCount: 0, lastFollowUpAt: null, convertedAt: null } });
const approve = async (qualification: any) => {
  const updated = await fixture.prisma.crmQualification.update({ where: { id: qualification.id }, data: { status: "APPROVED" } });
  const manifest = fixture.tables.artifactInputLineage.find((row: any) => row.artifactType === "CrmQualification" && row.artifactId === qualification.id);
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: alice, workspaceId: qualification.workspaceId,
    artifact: { kind: "CrmQualification", id: qualification.id }, content: updated, origin: "DERIVED", inputs: [], inheritedRoots: manifest.rootsJson });
  return updated;
};
beforeEach(() => {
  installSourcePermissionEpochFixture(fixture.prisma);
  for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
  fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
});

describe("CRM form ingress with actual input receipts", () => {
  it.each([alice, bob])("admits exact fresh forms, never the legacy lead body, for %j", async actor => {
    await createLead();
    const qualification = await submitQualification(form);
    const input = fixture.tables.crmQualificationFormInput[0];
    expect(input).toMatchObject({ qualificationId: qualification.id, workspaceId: ws, demoLeadId: "lead",
      companyName: "Company", website: "example.test", roleTitle: "Owner", aiExperience: "New", helpNeeded: "Planning" });
    expect(input).not.toHaveProperty("token");
    expect(input).not.toHaveProperty("qualifyToken");
    const roots = await captureArtifactInputProof(actor, ws, [{ kind: "CrmQualification", id: qualification.id }]);
    expect(await isArtifactInputProofReadable(actor, ws, roots)).toBe(true);
    await expect(captureArtifactInputProof(actor, ws, [{ kind: "DemoLead", id: "lead" }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(captureArtifactInputProof(actor, "ws-other", [{ kind: "CrmQualification", id: qualification.id }])).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    fixture.departed.add(actor.kind === "user" ? actor.user.id : "agent");
    await expect(captureArtifactInputProof(actor, ws, [{ kind: "CrmQualification", id: qualification.id }])).rejects.toThrow("Membership revoked");
  });

  it("rechecks a revoked token after the initial lookup and does not write any input", async () => {
    const lead = await createLead();
    fixture.prisma.demoLead.findUnique.mockImplementationOnce(async () => {
      fixture.tables.demoLead[0].qualifyToken = "rotated-link";
      return lead;
    });
    await expect(submitQualification(form)).rejects.toMatchObject({ code: "QUALIFICATION_LINK_UNAVAILABLE" });
    expect(fixture.tables.crmQualification).toHaveLength(0);
    expect(fixture.tables.crmQualificationFormInput).toHaveLength(0);
  });

  it("rolls back form output if the exact lead input changes during persistence", async () => {
    await createLead();
    const createInput = fixture.prisma.crmQualificationFormInput.create.getMockImplementation()!;
    fixture.prisma.crmQualificationFormInput.create.mockImplementationOnce(async (args: any) => {
      const input = await createInput(args);
      fixture.tables.demoLead[0].email = "changed@example.test";
      return input;
    });
    await expect(submitQualification(form)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.crmQualification).toHaveLength(0);
    expect(fixture.tables.crmQualificationFormInput).toHaveLength(0);
    expect(fixture.tables.artifactInputLineage).toHaveLength(0);
  });

  it("keeps retries separate and immutable, and rejects tampered input ancestry", async () => {
    await createLead();
    const first = await submitQualification(form);
    const second = await submitQualification({ ...form, helpNeeded: "Different request" });
    expect(first.id).not.toBe(second.id);
    expect(fixture.tables.crmQualificationFormInput).toHaveLength(2);
    const roots = await captureArtifactInputProof(alice, ws, [{ kind: "CrmQualification", id: first.id }]);
    fixture.tables.crmQualificationFormInput[0].helpNeeded = "Replaced after submission";
    expect(await isArtifactInputProofReadable(alice, ws, roots)).toBe(false);
    expect((await listQualifications(alice, ws)).items.map(row => row.id)).toEqual([second.id]);
  });

  it("filters unknown qualifications before pagination and totals in either workspace", async () => {
    await createLead();
    for (let index = 0; index < 105; index += 1) {
      await fixture.prisma.crmQualification.create({ data: { id: `unknown-${index}`, workspaceId: ws, demoLeadId: "lead", companyName: "Legacy unproved text", status: "PENDING_REVIEW" } });
    }
    const safe = await submitQualification(form);
    const otherLead = await createLead("other-lead", "ws-other");
    await fixture.prisma.demoLead.update({ where: { id: otherLead.id }, data: { qualifyToken: "other-link" } });
    const other = await submitQualification({ ...form, token: "other-link" });
    for (const actor of [alice, bob]) {
      expect(await listQualifications(actor, ws, { take: 1 })).toMatchObject({ total: 1, items: [{ id: safe.id }] });
      expect(await listQualifications(actor, "ws-other", { take: 1 })).toMatchObject({ total: 1, items: [{ id: other.id }] });
    }
    expect(fixture.prisma.crmQualification.count).not.toHaveBeenCalled();
    fixture.tables.demoLead.find((row: any) => row.id === "lead").email = "changed@example.test";
    expect(await listQualifications(alice, ws)).toMatchObject({ total: 0, items: [] });
  });

  it("advances scheduling markers without erasing form ancestry and retries without reminting", async () => {
    await createLead();
    const qualification = await approve(await submitQualification(form));
    const before = fixture.tables.artifactInputLineage.filter((row: any) => row.artifactId === qualification.id).at(-1);
    await sendSchedulingLinkEmail(alice, { workspaceId: ws, qualificationId: qualification.id });
    const after = fixture.tables.artifactInputLineage.filter((row: any) => row.artifactId === qualification.id).at(-1);
    expect(after.origin).toBe("DERIVED");
    expect(after.rootsJson).toEqual(before.rootsJson);
    expect(after.revision).toBe(before.revision + 1);
    expect(await isArtifactInputProofReadable(bob, ws, await captureArtifactInputProof(bob, ws, [{ kind: "CrmQualification", id: qualification.id }]))).toBe(true);
    await sendSchedulingLinkEmail(alice, { workspaceId: ws, qualificationId: qualification.id });
    expect(fixture.tables.artifactInputLineage.filter((row: any) => row.artifactId === qualification.id).at(-1)).toEqual(after);
    fixture.tables.crmQualificationFormInput[0].companyName = "Tampered";
    await expect(sendSchedulingLinkEmail(alice, { workspaceId: ws, qualificationId: qualification.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("withholds unknown, foreign and revoked scheduling records before updates", async () => {
    await createLead();
    await fixture.prisma.crmQualification.create({ data: { id: "legacy", workspaceId: ws, demoLeadId: "lead", status: "APPROVED" } });
    await expect(sendSchedulingLinkEmail(alice, { workspaceId: ws, qualificationId: "legacy" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(sendSchedulingLinkEmail(alice, { workspaceId: "ws-other", qualificationId: "legacy" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.departed.add("alice");
    await expect(sendSchedulingLinkEmail(alice, { workspaceId: ws, qualificationId: "legacy" })).rejects.toThrow("Membership revoked");
    expect(fixture.prisma.crmQualification.update).not.toHaveBeenCalled();
  });
});
