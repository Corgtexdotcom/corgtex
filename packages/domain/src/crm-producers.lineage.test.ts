import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

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
  const project = (row: any, args: any) => {
    if (!row) return null;
    let result = { ...row };
    if (args.include?.account) result.account = tables.crmAccount.find((parent) => parent.id === row.accountId) ?? null;
    if (args.include?.contact) result.contact = tables.crmContact.find((parent) => parent.id === row.contactId) ?? null;
    if (args.include?.deal) result.deal = tables.crmDeal.find((parent) => parent.id === row.dealId) ?? null;
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  };
  const names = ["informationCategoryPolicy", "crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "brainSource", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob"];
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
        const row = { id: `${name}-${tables[name].length + 1}`,
          ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}), archivedAt: null, createdAt: time,
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
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => ({ ...row }))]));
    try { return await run(prisma); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
  });
  return { beforeEmail: null as (() => void) | null, prisma, tables, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("../../shared/src/env", () => ({ env: {
  get RESEND_API_KEY() { fixture.beforeEmail?.(); return "synthetic-resend-key"; },
  EMAIL_FROM: "Synthetic <sender@example.test>", EMAIL_REPLY_TO: "reply@example.test",
} }));
vi.mock("../../shared/src/db", () => ({ prisma: fixture.prisma }));
import { sendEmail } from "../../shared/src/email";
const wire = vi.fn<typeof fetch>();
afterEach(() => { fixture.beforeEmail = null; vi.unstubAllGlobals(); });
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
import { captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage, withArtifactInputWriteFence } from "./source-lineage";
import { applyExtractionResult } from "./crm-extraction";
import { applyEnrichmentResult } from "./crm-enrichment";
import { recordDripFollowUp } from "./crm-drip";
const user = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;
const finance = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const agent = { kind: "agent", authProvider: "bootstrap", label: "crm", workspaceIds: ["ws-crm"] } as AppActor;
const ws = "ws-crm";
async function seedLead() {
  const lead = await fixture.prisma.demoLead.create({ data: { id: "lead", workspaceId: ws, email: "lead@synthetic.test", source: "demo_gate",
    companyHint: null, utmSource: null, convertedContactId: null, followUpCount: 0, lastFollowUpAt: null, convertedAt: null } });
  // This synthetic new row is constructed solely from the typed original, never a legacy row promoted in production.
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: user, workspaceId: ws, artifact: { kind: "DemoLead", id: lead.id }, content: lead,
    origin: "DERIVED", inputs: [{ kind: "DemoLeadIntakeInput", id: lead.id }] });
  return lead;
}
async function seedJob(kind: string, id: string, inputs: any[]) {
  const job = await fixture.prisma.workflowJob.create({ data: { id, workspaceId: ws, eventId: null, type: `agent.${kind}`,
    payload: { demoLeadId: "lead", followUpNumber: 1 }, createdAt: fixture.time } });
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: user, workspaceId: ws, artifact: { kind: "WorkflowJobInput", id }, content: job, origin: "DERIVED", inputs });
  return job;
}
async function dripRoots() {
  await seedLead(); await seedJob("crm-drip-followup", "job", [{ kind: "DemoLeadIntakeInput", id: "lead" }]);
  return captureArtifactInputProof(agent, ws, [{ kind: "DemoLead", id: "lead" }, { kind: "WorkflowJobInput", id: "job" }]);
}

describe("CRM writers with real source receipts", () => {
  beforeEach(() => {
    for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
    fixture.revoked.clear(); fixture.departed.clear(); fixture.beforeEmail = null; vi.clearAllMocks();
    wire.mockResolvedValue(new Response(JSON.stringify({ id: "synthetic-message" }), {status: 200, headers: {"Content-Type": "application/json"}}));
    vi.stubGlobal("fetch", wire);
    fixture.prisma.$queryRaw.mockReset().mockResolvedValue([]);
    fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
    installSourcePermissionEpochFixture(fixture.prisma);
  });
  it("never promotes legacy raw workflow payloads or generated lead fields into original receipts", async () => {
    const lead = await fixture.prisma.demoLead.create({ data: { id: "legacy-lead", workspaceId: ws, email: "lead@synthetic.test", source: "demo_gate", companyHint: "Unproven generated company", followUpCount: 3 } });
    await fixture.prisma.workflowJob.create({ data: { id: "legacy-job", workspaceId: ws, eventId: null, type: "agent.crm-drip-followup", payload: { demoLeadId: lead.id, followUpNumber: 4 } } });
    expect((await captureArtifactInputProof(agent, ws, [{ kind: "DemoLeadIntakeInput", id: lead.id }])).length).toBeGreaterThan(0);
    await expect(captureArtifactInputProof(agent, ws, [{ kind: "DemoLead", id: lead.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(captureArtifactInputProof(agent, ws, [{ kind: "WorkflowJobInput", id: "legacy-job" }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
  it("preserves unknown extracted history and raw originals without granting prior generated fields", async () => {
    await seedLead();
    const qualification = await fixture.prisma.crmQualification.create({ data: { id: "qual", workspaceId: ws, demoLeadId: "lead", responseChannel: "email_reply",
      rawEmailReply: "Original inbound reply", rawEmailSubject: "Original subject", companyName: null, website: "Unproven legacy website", aiExperience: null, helpNeeded: null } });
    const roots = await captureArtifactInputProof(agent, ws, [{ kind: "CrmQualificationEmailInput", id: "qual" }]);
    await applyExtractionResult(ws, "qual", { companyName: "Copied company", website: "New website" }, { actor: agent, lineageRoots: roots });
    const after = fixture.tables.crmQualification[0];
    expect(after.rawEmailReply).toBe(qualification.rawEmailReply); expect(after.rawEmailSubject).toBe(qualification.rawEmailSubject);
    expect(after.website).toBe("Unproven legacy website"); expect(after.companyName).toBe("Copied company");
    expect(fixture.tables.artifactInputSnapshot.some(row => row.sourceKind === "CrmQualification" && row.origin === "UNKNOWN" && row.contentJson.website === "Unproven legacy website")).toBe(true);
    expect(await readableArtifactIds(agent, ws, "CrmQualification", [after])).toEqual(new Set());
    expect(await isArtifactInputProofReadable(agent, ws, roots)).toBe(true);
  });
  it("rejects a stale captured inbound email before partial mutation", async () => {
    await seedLead();
    await fixture.prisma.crmQualification.create({ data: { id: "qual", workspaceId: ws, demoLeadId: "lead", responseChannel: "email_reply", rawEmailReply: "Before", rawEmailSubject: null, companyName: null } });
    const roots = await captureArtifactInputProof(agent, ws, [{ kind: "CrmQualificationEmailInput", id: "qual" }]);
    fixture.tables.crmQualification[0].rawEmailReply = "Changed";
    await expect(applyExtractionResult(ws, "qual", { companyName: "Stale" }, { actor: agent, lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.crmQualification[0].companyName).toBeNull();
  });
  it("persists known enrichment and activity atomically using the consumed contact revision", async () => {
    const contact = await fixture.prisma.crmContact.create({ data: { id: "contact", workspaceId: ws, email: "lead@synthetic.test", company: "Synthetic", tags: ["old"], accountId: null } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: user, workspaceId: ws, artifact: { kind: "CrmContact", id: contact.id }, content: contact, origin: "HUMAN_ORIGINAL", inputs: [] });
    const roots = await captureArtifactInputProof(agent, ws, [{ kind: "CrmContact", id: contact.id }]);
    await applyEnrichmentResult(ws, "contact", { industry: "Software", confidence: 0.8 }, { actor: agent, lineageRoots: roots });
    expect(fixture.tables.crmContact[0].tags).toEqual(["old", "Software"]);
    expect(await readableArtifactIds(agent, ws, "CrmContact", fixture.tables.crmContact)).toEqual(new Set(["contact"]));
    expect(await readableArtifactIds(agent, ws, "CrmActivity", fixture.tables.crmActivity)).toEqual(new Set([fixture.tables.crmActivity[0].id]));
    fixture.tables.crmContact[0].archivedAt = fixture.time;
    expect(await readableArtifactIds(agent, ws, "CrmActivity", fixture.tables.crmActivity)).toEqual(new Set());
  });
  it("rejects changed or foreign contact input before tags or activity writes", async () => {
    const contact = await fixture.prisma.crmContact.create({ data: { id: "contact", workspaceId: ws, email: "before@synthetic.test", tags: [], accountId: null } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: user, workspaceId: ws, artifact: { kind: "CrmContact", id: contact.id }, content: contact, origin: "HUMAN_ORIGINAL", inputs: [] });
    const roots = await captureArtifactInputProof(agent, ws, [{ kind: "CrmContact", id: contact.id }]);
    fixture.tables.crmContact[0].email = "changed@synthetic.test";
    await expect(applyEnrichmentResult(ws, "contact", { confidence: 0.8, industry: "Stale" }, { actor: agent, lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(applyEnrichmentResult("ws-other", "contact", { confidence: 0.8, industry: "Foreign" }, { actor: user, lineageRoots: roots })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.tables.crmContact[0].tags).toEqual([]); expect(fixture.tables.crmActivity).toHaveLength(0);
  });
  it("stores exact send result and operation id, advances receipts, and rejects repeated delivery", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => ({ status: "SENT" as const, providerMessageId: "message" }));
    const opts = { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send };
    await recordDripFollowUp(ws, "lead", "Proven body", opts);
    expect(send).toHaveBeenCalledWith("lead@synthetic.test", "job", expect.objectContaining({signal: expect.any(AbortSignal), authorizeAttempt: expect.any(Function)})); expect(fixture.tables.demoLead[0].followUpCount).toBe(1);
    expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd)).toEqual({ operationId: "job", status: "SENT", providerMessageId: "message", emailContent: "Proven body" });
    expect(await readableArtifactIds(agent, ws, "DemoLead", fixture.tables.demoLead)).toEqual(new Set(["lead"]));
    expect(await readableArtifactIds(agent, ws, "CrmActivity", fixture.tables.crmActivity)).toEqual(new Set([fixture.tables.crmActivity[0].id]));
    await expect(recordDripFollowUp(ws, "lead", "Proven body", opts)).rejects.toMatchObject({ code: "DELIVERY_ALREADY_RESERVED" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "member", "unchanged"])("replays original drip authority at the actual Resend HTTP boundary: %s", async change => {
    const roots = await dripRoots();
    fixture.beforeEmail = () => {
      if (change === "source") fixture.tables.workflowJob[0].payload = {demoLeadId: "lead", followUpNumber: 1, changed: true};
      if (change === "member") fixture.departed.add("agent");
    };
    const send = vi.fn((_recipient, _operationId, controls) => sendEmail({to: "lead@synthetic.test", subject: "Original", html: "<p>Original</p>"}, controls));
    const work = recordDripFollowUp(ws, "lead", "Proven body", {actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send});
    if (change === "unchanged") {
      await expect(work).resolves.toMatchObject({delivery: {status: "SENT"}});
      expect(wire).toHaveBeenCalledTimes(1);
      expect(wire.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fixture.tables.demoLead[0].followUpCount).toBe(1);
    } else {
      await expect(work).rejects.toThrow(change === "member" ? "Membership revoked" : "Original follow-up inputs");
      expect(wire).not.toHaveBeenCalled();
      expect(fixture.tables.demoLead[0].followUpCount).toBe(0);
      expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd).status).toBe("RESERVED");
    }
  });
  it("rechecks the original worker fence after email credential preparation", async () => {
    const roots = await dripRoots();
    let active = true;
    fixture.beforeEmail = () => { active = false; };
    const send = vi.fn((_recipient, _operationId, controls) => sendEmail({to: "lead@synthetic.test", subject: "Original", html: "Original"}, controls));
    await expect(withArtifactInputWriteFence(async () => {
      if (!active) throw new Error("Synthetic original lease lost");
    }, () => recordDripFollowUp(ws, "lead", "Body", {actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send}))).rejects.toThrow("Synthetic original lease lost");
    expect(wire).not.toHaveBeenCalled();
    expect(fixture.tables.demoLead[0].followUpCount).toBe(0);
    expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd).status).toBe("RESERVED");
  });
  it("keeps a swallowed drip dispatch denial fatal without marking SENT", async () => {
    const roots = await dripRoots();
    const send = vi.fn(async (_recipient, _operationId, controls) => {
      fixture.departed.add("agent");
      try { await controls.authorizeAttempt({signal: controls.signal}); } catch { /* simulate provider wrapper */ }
      return {status: "SENT" as const, providerMessageId: "fake-success"};
    });
    await expect(recordDripFollowUp(ws, "lead", "Body", {actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send})).rejects.toThrow("Membership revoked");
    expect(fixture.tables.demoLead[0].followUpCount).toBe(0);
    expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd).status).toBe("RESERVED");
  });
  it("requires the authoritative job target even when a different operation has readable roots", async () => {
    const roots = await dripRoots();
    const wrong = await fixture.prisma.workflowJob.create({ data: { id: "wrong-job", workspaceId: ws, eventId: null, type: "agent.crm-drip-followup",
      payload: { demoLeadId: "another-lead", followUpNumber: 1 } } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: user, workspaceId: ws, artifact: { kind: "WorkflowJobInput", id: wrong.id }, content: wrong,
      origin: "DERIVED", inputs: [{ kind: "DemoLeadIntakeInput", id: "lead" }] });
    const wrongRoots = await captureArtifactInputProof(agent, ws, [{ kind: "WorkflowJobInput", id: wrong.id }]);
    const send = vi.fn();
    await expect(recordDripFollowUp(ws, "lead", "Body", { actor: agent, lineageRoots: [...roots, ...wrongRoots], operationId: wrong.id, expectedFollowUpNumber: 1, send })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(send).not.toHaveBeenCalled(); expect(fixture.tables.crmActivity).toHaveLength(0);
  });
  it("keeps durable reservation on provider uncertainty and never automatically repeats an attempted email", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => { throw new Error("Synthetic uncertain provider response"); });
    const opts = { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send };
    await expect(recordDripFollowUp(ws, "lead", "Proven body", opts)).rejects.toThrow("Synthetic uncertain");
    expect(fixture.tables.demoLead[0].followUpCount).toBe(0); expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd).status).toBe("RESERVED");
    await expect(recordDripFollowUp(ws, "lead", "Proven body", opts)).rejects.toMatchObject({ code: "DELIVERY_ALREADY_RESERVED" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not send a reservation cancelled after its durable commit", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => ({ status: "SENT" as const, providerMessageId: "message" }));
    const transaction = fixture.prisma.$transaction.getMockImplementation()!;
    fixture.prisma.$transaction.mockImplementationOnce(async (work: any) => {
      const result = await transaction(work); fixture.tables.crmActivity[0].archivedAt = fixture.time; return result;
    });
    await expect(recordDripFollowUp(ws, "lead", "Body", { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send })).rejects.toMatchObject({ code: "DELIVERY_ALREADY_RESERVED" });
    expect(send).not.toHaveBeenCalled(); expect(fixture.tables.demoLead[0].followUpCount).toBe(0);
  });
  it("does not repeat delivery when the database fails after a successful provider response", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => ({ status: "SENT" as const, providerMessageId: "message" }));
    const opts = { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send };
    fixture.prisma.crmActivity.update.mockRejectedValueOnce(new Error("Synthetic commit-path failure"));
    await expect(recordDripFollowUp(ws, "lead", "Body", opts)).rejects.toThrow("Synthetic commit-path failure");
    expect(fixture.tables.demoLead[0].followUpCount).toBe(0); expect(JSON.parse(fixture.tables.crmActivity[0].bodyMd).status).toBe("RESERVED");
    await expect(recordDripFollowUp(ws, "lead", "Body", opts)).rejects.toMatchObject({ code: "DELIVERY_ALREADY_RESERVED" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not treat a skipped or missing-provider-id send as successful", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => ({ status: "SKIPPED" as const, reason: "Synthetic missing credentials" }));
    await expect(recordDripFollowUp(ws, "lead", "Body", { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send })).rejects.toMatchObject({ code: "DELIVERY_UNCERTAIN" });
    expect(fixture.tables.demoLead[0].followUpCount).toBe(0); expect(fixture.tables.crmActivity).toHaveLength(1);
  });
  it("rejects changed recipient, unknown operation and worker lease loss before outbound", async () => {
    const roots = await dripRoots(); const send = vi.fn(async () => ({ status: "SENT" as const, providerMessageId: "message" }));
    const opts = { actor: agent, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send };
    fixture.tables.demoLead[0].email = "changed@synthetic.test";
    await expect(recordDripFollowUp(ws, "lead", "Body", opts)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    fixture.tables.demoLead[0].email = "lead@synthetic.test";
    await expect(recordDripFollowUp(ws, "lead", "Body", { ...opts, lineageRoots: [] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(withArtifactInputWriteFence(async () => { throw new Error("Synthetic lost lease"); }, () => recordDripFollowUp(ws, "lead", "Body", opts))).rejects.toThrow("Synthetic lost lease");
    expect(send).not.toHaveBeenCalled(); expect(fixture.tables.crmActivity).toHaveLength(0);
  });
  it("withholds private context even for its entitled author and does not infer a recipient grant from email", async () => {
    await seedLead();
    const doc = await fixture.prisma.document.create({ data: { id: "private", workspaceId: ws, title: "Finance", textContent: "Finance buyer context", accessDomain: "FINANCE" } });
    const original = await fixture.prisma.brainSource.create({ data: { id: "original-private", workspaceId: ws,
      sourceType: "ARTICLE", channel: "manual", tier: "reference", title: doc.title, content: doc.textContent,
      accessDomain: "FINANCE", archivedAt: null } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws,
      artifact: { kind: "BrainSource", id: original.id }, content: original, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws,
      artifact: { kind: "Document", id: doc.id }, content: doc, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: original.id }] });
    const lead = fixture.tables.demoLead[0];
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: ws, artifact: { kind: "DemoLead", id: "lead" }, content: lead, origin: "DERIVED", inputs: [{ kind: "Document", id: doc.id }] });
    await seedJob("crm-drip-followup", "job", [{ kind: "DemoLeadIntakeInput", id: "lead" }]);
    const roots = await captureArtifactInputProof(finance, ws, [{ kind: "DemoLead", id: "lead" }, { kind: "WorkflowJobInput", id: "job" }]);
    const send = vi.fn();
    await expect(recordDripFollowUp(ws, "lead", "Private body", { actor: finance, lineageRoots: roots, operationId: "job", expectedFollowUpNumber: 1, send })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await expect(captureArtifactInputProof(agent, ws, [{ kind: "DemoLead", id: "lead" }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(send).not.toHaveBeenCalled(); expect(fixture.tables.crmActivity).toHaveLength(0);
  });
});
