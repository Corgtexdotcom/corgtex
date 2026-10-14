import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const names = ["crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob"];
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
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => ({ ...row }))]));
    try { return await run(prisma); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
  });
  return { prisma, tables, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user?.id === "finance" && !fixture.revoked.has("finance")
  ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("../../domain/src/crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
vi.mock("@corgtex/domain", async () => ({ ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/errors") }));
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { recordFreshDemoLeadLineage, recordFreshEmailQualificationLineage } from "../../domain/src/crm-ingress-lineage";
import { enqueueCrmLineageJob } from "./crm-job-lineage";
const ws = "ws-crm";
const alice = {kind: "user", user: {id: "alice", email: "alice@example.test"}} as AppActor;
const bob = {kind: "user", user: {id: "bob", email: "bob@example.test"}} as AppActor;
const createLead = (id = "lead", workspaceId = ws) => fixture.prisma.demoLead.create({data: {id, workspaceId, email: `${id}@example.test`, source: "demo_gate",
  companyHint: null, utmSource: null, convertedContactId: null, followUpCount: 0, lastFollowUpAt: null, convertedAt: null}});
const attestLead = async (lead: any) => recordFreshDemoLeadLineage(fixture.prisma, lead, {createdId: lead.id, email: lead.email, source: lead.source});
const drip = (leadId = "lead", workspaceId = ws) => ({workspaceId, eventId: null, type: "agent.crm-drip-followup",
  payload: {demoLeadId: leadId, followUpNumber: 1}, dedupeKey: `${workspaceId}:${leadId}:drip`});
beforeEach(() => {
  for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
  fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
  const epochs = new Map<string, bigint>();
  fixture.prisma.$executeRaw.mockImplementation(async (query: any) => {
    if (query.sql?.includes('INSERT INTO "SourcePermissionEpoch"')) for (let i = 0; i < query.values.length; i += 4) {
      const [, ws, kind, id] = query.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]);
      if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  });
  fixture.prisma.$queryRaw.mockImplementation(async (query: any) => {
    if (!query.sql?.includes('FROM "SourcePermissionEpoch"')) return [];
    const [ws, ...pairs] = query.values; const rows = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
      if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
    }
    return rows;
  });
});

describe("fresh CRM ingress and jobs with actual source helpers", () => {
  it.each([alice, bob])("attests fresh exact lead intake for %j without granting another workspace", async actor => {
    const lead = await createLead(); await attestLead(lead);
    const roots = await captureArtifactInputProof(actor, ws, [{kind: "DemoLead", id: lead.id}]);
    expect(await isArtifactInputProofReadable(actor, ws, roots)).toBe(true);
    await expect(captureArtifactInputProof(actor, "ws-other", [{kind: "DemoLead", id: lead.id}])).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    const other = await createLead("other", "ws-other"); await attestLead(other);
    expect(await isArtifactInputProofReadable(actor, "ws-other", await captureArtifactInputProof(actor, "ws-other", [{kind: "DemoLead", id: other.id}]))).toBe(true);
    fixture.departed.add(actor.kind === "user" ? actor.user.id : "agent");
    await expect(captureArtifactInputProof(actor, ws, [{kind: "DemoLead", id: lead.id}])).rejects.toThrow("Membership revoked");
  });

  it("never promotes a legacy lead on a returning visit and rejects mixed fresh fields", async () => {
    const lead = await createLead();
    await recordFreshDemoLeadLineage(fixture.prisma, lead, {createdId: "new-upsert-id", email: lead.email, source: lead.source});
    await expect(captureArtifactInputProof(alice, ws, [{kind: "DemoLead", id: lead.id}])).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    await expect(recordFreshDemoLeadLineage(fixture.prisma, {...lead, companyHint: "Unproven model company"},
      {createdId: lead.id, email: lead.email, source: lead.source})).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(fixture.tables.artifactInputLineage.some((row: any) => row.artifactType === "DemoLead")).toBe(false);
  });

  it("records a complete fresh email qualification while keeping extracted fields non-native", async () => {
    const lead = await createLead(); await attestLead(lead);
    const qualification = await fixture.prisma.crmQualification.create({data: {id: "qualification", workspaceId: ws,
      demoLeadId: lead.id, responseChannel: "email_reply", rawEmailReply: "Exact received body", rawEmailSubject: "Exact subject", status: "PENDING_REVIEW"}});
    const request = {createdId: qualification.id, workspaceId: ws, demoLeadId: lead.id, bodyText: qualification.rawEmailReply, subject: qualification.rawEmailSubject};
    await recordFreshEmailQualificationLineage(fixture.prisma, qualification, request);
    expect(await isArtifactInputProofReadable(alice, ws, await captureArtifactInputProof(alice, ws, [{kind: "CrmQualification", id: qualification.id}]))).toBe(true);
    await expect(recordFreshEmailQualificationLineage(fixture.prisma, {...qualification, companyName: "Generated company"}, request))
      .rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    const draft = {workspaceId: ws, eventId: null, type: "agent.crm-email-extraction", dedupeKey: "email-job", payload: {qualificationId: qualification.id, aggregateId: "forged", email: "forged@example.test"}};
    const job = await enqueueCrmLineageJob(fixture.prisma, draft);
    expect(job.scheduled).toBe(true);
    expect(fixture.tables.workflowJob[0].payload).toEqual({eventId: "", aggregateId: qualification.id, qualificationId: qualification.id});
    expect(await isArtifactInputProofReadable(bob, ws, await captureArtifactInputProof(bob, ws, [{kind: "WorkflowJobInput", id: job.jobId!}]))).toBe(true);
  });

  it("derives drip jobs from exact full source snapshots and retries without reminting proof", async () => {
    const lead = await createLead(); await attestLead(lead);
    const first = await enqueueCrmLineageJob(fixture.prisma, drip());
    expect(first).toMatchObject({handled: true, scheduled: true});
    const manifests = fixture.tables.artifactInputLineage.length;
    expect(await enqueueCrmLineageJob(fixture.prisma, drip())).toEqual({handled: true, scheduled: false, jobId: first.jobId});
    expect(fixture.tables.artifactInputLineage).toHaveLength(manifests);
    expect(await enqueueCrmLineageJob(fixture.prisma, {...drip(), payload: {demoLeadId: "substituted", followUpNumber: 1}})).toEqual({handled: true, scheduled: false});
    const roots = await captureArtifactInputProof(alice, ws, [{kind: "WorkflowJobInput", id: first.jobId!}]);
    fixture.tables.workflowJob[0].payload.followUpNumber = 99;
    expect(await isArtifactInputProofReadable(alice, ws, roots)).toBe(false);
    expect(await enqueueCrmLineageJob(fixture.prisma, drip())).toEqual({handled: true, scheduled: false});
  });

  it("withholds unknown full leads, changed follow-up numbers and foreign source ids", async () => {
    const lead = await createLead();
    expect(await enqueueCrmLineageJob(fixture.prisma, drip())).toEqual({handled: true, scheduled: false});
    await attestLead(lead);
    expect(await enqueueCrmLineageJob(fixture.prisma, {...drip(), payload: {demoLeadId: lead.id, followUpNumber: 3}})).toEqual({handled: true, scheduled: false});
    expect(await enqueueCrmLineageJob(fixture.prisma, drip(lead.id, "ws-other"))).toEqual({handled: true, scheduled: false});
    expect(fixture.tables.workflowJob).toHaveLength(0);
  });

  it("withholds a source changed during immutable capture before job persistence", async () => {
    const lead = await createLead(); await attestLead(lead);
    const create = fixture.prisma.artifactInputSnapshot.create.getMockImplementation();
    fixture.prisma.artifactInputSnapshot.create.mockImplementationOnce(async (args: any) => {
      const snapshot = await create(args);
      fixture.tables.demoLead[0].companyHint = "Changed after capture";
      return snapshot;
    });
    expect(await enqueueCrmLineageJob(fixture.prisma, drip())).toEqual({handled: true, scheduled: false});
    expect(fixture.tables.workflowJob).toHaveLength(0);
  });

  it("reconstructs enrichment email from the admitted qualification lead, ignoring stale event text", async () => {
    const lead = await createLead(); await attestLead(lead);
    const qualification = await fixture.prisma.crmQualification.create({data: {id: "approved", workspaceId: ws,
      demoLeadId: lead.id, responseChannel: "email_reply", rawEmailReply: "Original company", rawEmailSubject: "Subject", status: "PENDING_REVIEW"}});
    await recordFreshEmailQualificationLineage(fixture.prisma, qualification, {createdId: qualification.id, workspaceId: ws,
      demoLeadId: lead.id, bodyText: qualification.rawEmailReply, subject: qualification.rawEmailSubject});
    const {advanceHumanArtifactInputLineage} = await import("../../domain/src/source-lineage");
    const after = await fixture.prisma.crmQualification.update({where: {id: qualification.id}, data: {status: "APPROVED", reviewedByUserId: "alice"}});
    await advanceHumanArtifactInputLineage({tx: fixture.prisma, actor: alice, workspaceId: ws,
      artifact: {kind: "CrmQualification", id: qualification.id}, before: qualification, after});
    const contact = await fixture.prisma.crmContact.create({data: {id: "contact", workspaceId: ws, email: lead.email, company: "Original company", accountId: null}});
    await recordArtifactInputLineage({tx: fixture.prisma, actor: alice, workspaceId: ws,
      artifact: {kind: "CrmContact", id: contact.id}, content: contact, origin: "HUMAN_ORIGINAL", inputs: []});
    const result = await enqueueCrmLineageJob(fixture.prisma, {workspaceId: ws, eventId: null, type: "agent.crm-lead-enrichment", dedupeKey: "enrichment",
      payload: {aggregateId: qualification.id, email: "untrusted-old-event@example.test"}});
    expect(result.scheduled).toBe(true);
    expect(fixture.tables.workflowJob[0].payload.email).toBe(lead.email);
    await expect(captureArtifactInputProof(bob, ws, [{kind: "WorkflowJobInput", id: result.jobId!}])).resolves.not.toHaveLength(0);
  });

  it("does not certify a preexisting unknown job even when its current source is proven", async () => {
    const lead = await createLead(); await attestLead(lead);
    await fixture.prisma.workflowJob.create({data: {...drip(), id: "legacy-job"}});
    const manifests = fixture.tables.artifactInputLineage.length;
    expect(await enqueueCrmLineageJob(fixture.prisma, drip())).toEqual({handled: true, scheduled: false});
    expect(fixture.tables.artifactInputLineage).toHaveLength(manifests);
  });
});
