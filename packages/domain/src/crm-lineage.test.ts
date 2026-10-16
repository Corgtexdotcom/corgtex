import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const epochs = new Map<string, bigint>();
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
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult"];
  const prisma: any = { $queryRaw: vi.fn(async (query: any) => {
    if (!query.strings?.join("").includes('FROM "SourcePermissionEpoch"')) return [];
    const [workspaceId, ...pairs] = query.values; const result = [];
    for (let index = 0; index < pairs.length; index += 2) {
      const [sourceKind, sourceId] = pairs.slice(index, index + 2); const epoch = epochs.get(JSON.stringify([workspaceId, sourceKind, sourceId]));
      if (epoch !== undefined) result.push({ sourceKind, sourceId, epoch });
    }
    return result;
  }), $executeRaw: vi.fn(async (query: any) => {
    if (query.strings?.join("").includes('INSERT INTO "SourcePermissionEpoch"')) for (let index = 0; index < query.values.length; index += 4) {
      const [, workspaceId, kind, id] = query.values.slice(index, index + 4); const key = JSON.stringify([workspaceId, kind, id]);
      if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  }),
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
        tables[name][index] = { ...tables[name][index], ...data }; return { ...tables[name][index] };
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
  return { prisma, tables, time, epochs, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (workspaceId !== "ws-crm" || fixture.departed.has(actor.user.id)) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user.id}`, role: "CONTRIBUTOR" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user.id === "finance" && !fixture.revoked.has("finance")
  ? ["WORKSPACE", "FINANCE"] : ["WORKSPACE"]) }));
vi.mock("./crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./customer-lifecycle", () => ({ registerCustomerDeployment: vi.fn() }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
vi.mock("./actions", () => ({ createAction: vi.fn() }));
vi.mock("./tensions", () => ({ createTension: vi.fn() }));
vi.mock("./proposals", () => ({ createProposal: vi.fn() }));
vi.mock("./meetings", () => ({ createMeeting: vi.fn() }));
vi.mock("./brain", () => ({ createArticle: vi.fn() }));
vi.mock("./build-artifacts", () => ({ upsertBuildArtifact: vi.fn() }));
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, readableArtifactIds, recordArtifactInputLineage, type LineageInput } from "./source-lineage";
import { crmPage, readCrmRows } from "./crm-lineage";
import { createActivity, createContact, createCrmAccount, createDeal, updateCrmAccount, listContacts, listDeals, listCrmActivities, listCrmAccounts,
  createCommunicationSuggestion, updateCommunicationSuggestion, requestCommunicationSuggestionExecution, markCommunicationSuggestionSent,
  declineCommunicationSuggestion, failCommunicationSuggestion, listCommunicationSuggestions } from "./crm";

const finance = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const general = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;

describe("CRM input receipts", () => {
  beforeEach(() => {
    for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
    fixture.revoked.clear(); fixture.departed.clear(); fixture.epochs.clear(); vi.clearAllMocks();
    fixture.tables.workspace.push({ id: "ws-crm", name: "Synthetic CRM workspace", slug: "synthetic-crm", description: null, plan: "FREE", createdAt: fixture.time, updatedAt: fixture.time });
  });

  it("carries meeting ancestry into companies, contacts, leads and tasks and gates bodies, counts and paths", async () => {
    const source = await fixture.prisma.document.create({ data: { id: "finance-source", workspaceId: "ws-crm", title: "Finance source",
      textContent: "Restricted buyer context", accessDomain: "FINANCE" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "Document", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    const meeting = await fixture.prisma.meeting.create({ data: { id: "meeting", workspaceId: "ws-crm", title: "Original meeting", transcript: "Original transcript" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "Meeting", id: meeting.id },
      content: meeting, origin: "HUMAN_ORIGINAL", inputs: [] });
    const insight = await fixture.prisma.meetingInsight.create({ data: { id: "insight", workspaceId: "ws-crm", meetingId: meeting.id,
      title: "Restricted buyer", bodyMd: "Restricted follow up", type: "CRM_CONTACT", status: "CONFIRMED" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "MeetingInsight", id: insight.id },
      content: insight, origin: "DERIVED", inputs: [{ kind: "Meeting", id: meeting.id }, { kind: "Document", id: source.id }], transitiveOnlyKinds: ["Meeting"] });
    const lineageRoots = await captureArtifactInputSnapshotProof(finance, "ws-crm", { kind: "MeetingInsight", id: insight.id }, fixture.prisma);
    const contact = await createContact(finance, { workspaceId: "ws-crm", email: "buyer@restricted.test", company: "Restricted company", lineageRoots });
    const deal = await createDeal(finance, { workspaceId: "ws-crm", contactId: contact.id, title: "Restricted lead", lineageRoots });
    const task = await createActivity(finance, { workspaceId: "ws-crm", contactId: contact.id, dealId: deal.id, title: "Restricted task", type: "TASK", lineageRoots });
    const account = fixture.tables.crmAccount[0];
    for (const [kind, row] of [["CrmAccount", account], ["CrmContact", contact], ["CrmDeal", deal], ["CrmActivity", task]] as [LineageInput["kind"], any][]) {
      expect(await readableArtifactIds(finance, "ws-crm", kind, [row], fixture.prisma)).toEqual(new Set([row.id]));
      expect(await readableArtifactIds(general, "ws-crm", kind, [row], fixture.prisma)).toEqual(new Set());
      const manifest = [...fixture.tables.artifactInputLineage].reverse().find((entry) => entry.artifactType === kind && entry.artifactId === row.id);
      expect(manifest.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Document", id: source.id })]));
    }
    const publicAccount = await createCrmAccount(general, { workspaceId: "ws-crm", name: "Public original", domain: "public.test" });
    await createContact(general, { workspaceId: "ws-crm", email: "public@public.test", accountId: publicAccount.id });
    await fixture.prisma.crmContact.create({ data: { workspaceId: "ws-crm", email: "legacy@public.test", name: "Unknown legacy" } });
    expect(await listContacts(general, "ws-crm", { take: 1 })).toMatchObject({ total: 1, items: [{ email: "public@public.test" }] });
    expect(await listDeals(general, "ws-crm")).toMatchObject({ total: 0, items: [] });
    expect(await listCrmActivities(general, "ws-crm")).toMatchObject({ total: 0, items: [] });
    const accounts = await listCrmAccounts(general, "ws-crm");
    expect(accounts.total).toBe(1); expect(accounts.items[0]._count.contacts).toBe(1);
    expect(JSON.stringify(accounts)).not.toContain("Restricted");
    fixture.revoked.add("finance");
    expect(await listContacts(finance, "ws-crm")).toMatchObject({ total: 1 });
    fixture.revoked.clear(); fixture.tables.document[0] = { ...source, archivedAt: fixture.time };
    fixture.epochs.set(JSON.stringify(["ws-crm", "Document", source.id]), 1n);
    expect(await readableArtifactIds(finance, "ws-crm", "CrmActivity", [task], fixture.prisma)).toEqual(new Set());
    fixture.tables.document[0] = { ...source, textContent: "Changed on restore" };
    fixture.epochs.set(JSON.stringify(["ws-crm", "Document", source.id]), 2n);
    expect(await readableArtifactIds(finance, "ws-crm", "CrmContact", [contact], fixture.prisma)).toEqual(new Set());
    fixture.departed.add("finance");
    await expect(listCrmActivities(finance, "ws-crm")).rejects.toThrow("Membership revoked");
  });

  it("keeps edited legacy and uncaptured imported bodies unknown", async () => {
    const legacy = await fixture.prisma.crmAccount.create({ data: { workspaceId: "ws-crm", name: "Legacy body", slug: "legacy" } });
    const edited = await updateCrmAccount(general, { workspaceId: "ws-crm", accountId: legacy.id, descriptionMd: "Human clarification" });
    expect(edited.name).toBe("Legacy body");
    expect(await readableArtifactIds(general, "ws-crm", "CrmAccount", [edited], fixture.prisma)).toEqual(new Set());
    expect(fixture.tables.artifactInputLineage.at(-1).origin).toBe("UNKNOWN");
    const imported = await createCrmAccount(general, { workspaceId: "ws-crm", name: "Uncaptured import", source: "import" });
    expect(await readableArtifactIds(general, "ws-crm", "CrmAccount", [imported], fixture.prisma)).toEqual(new Set());
  });

  it("rejects stale captured inputs before CRM outputs persist", async () => {
    const source = await fixture.prisma.document.create({ data: { id: "source", workspaceId: "ws-crm", title: "Original", accessDomain: "WORKSPACE", textContent: "Original" } });
    const { lineageContentFingerprint } = await import("./source-lineage");
    const lineageRoots = [{ kind: "Document" as const, id: source.id, fingerprint: lineageContentFingerprint("Document", source) }];
    fixture.tables.document[0].textContent = "Changed";
    await expect(createContact(finance, { workspaceId: "ws-crm", email: "buyer@changed.test", lineageRoots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.crmAccount).toEqual([]); expect(fixture.tables.crmContact).toEqual([]);
  });

  it("scans past hidden pages before pagination and refuses incomplete totals at its budget", async () => {
    const rows = Array.from({ length: 102 }, (_, index) => ({ id: `raw-${index}` }));
    const fetch = vi.fn(async (page) => { const start = page.cursor ? rows.findIndex((row) => row.id === page.cursor.id) + page.skip : 0;
      return rows.slice(start, start + page.take); });
    // Fresh synthetic human originals have explicit receipts; only the final two are accessible.
    fixture.tables.document = rows.map((row, index) => ({ ...row, workspaceId: "ws-crm", informationCategory: "GENERAL", accessDomain: index < 100 ? "FINANCE" : "WORKSPACE" }));
    for (const document of fixture.tables.document) await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm",
      artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
    const admitted = await readCrmRows(general, "ws-crm", "Document", async (page) => {
      const ids = await fetch(page); return ids.map((row) => fixture.tables.document.find((entry) => entry.id === row.id));
    });
    expect(crmPage(admitted, 1, 1)).toMatchObject({ total: 2, items: [{ id: "raw-101" }] });
    expect(fetch.mock.calls[1][0]).toEqual({ take: 100, cursor: { id: "raw-99" }, skip: 1 });
    let pageIndex = 0;
    const endless = vi.fn(async (_page: {take: number}) => Array.from({ length: 100 }, (_, index) => ({ id: `unknown-${pageIndex++}-${index}` })));
    await expect(readCrmRows(general, "ws-crm", "CrmAccount", endless)).rejects.toMatchObject({ code: "CRM_READ_BUDGET", status: 413 });
    expect(endless).toHaveBeenCalledTimes(51);
    expect(endless.mock.calls.at(-1)?.[0]).toMatchObject({take: 1, skip: 1});
  });

  it.each([4_999, 5_000, 5_001])("distinguishes a complete %i-row collection from one beyond the CRM budget", async count => {
    const rows = Array.from({length: count}, (_, index) => ({id: `unknown-${index}`}));
    const fetch = vi.fn(async (page: {take: number; cursor?: {id: string}; skip?: number}) => {
      const start = page.cursor ? rows.findIndex(row => row.id === page.cursor!.id) + (page.skip ?? 0) : 0;
      return rows.slice(start, start + page.take);
    });
    const result = readCrmRows(general, "ws-crm", "CrmAccount", fetch);
    if (count > 5_000) await expect(result).rejects.toMatchObject({code: "CRM_READ_BUDGET"});
    else expect(crmPage(await result, 50, 0)).toEqual({items: [], total: 0, take: 50, skip: 0});
    if (count >= 5_000) expect(fetch.mock.calls.at(-1)?.[0]).toEqual({take: 1, cursor: {id: "unknown-4999"}, skip: 1});
  });

  it("records full prompt and recipient receipts through suggestion edits, state transitions and sent activity copies", async () => {
    const account = await createCrmAccount(finance, { workspaceId: "ws-crm", name: "Public account" });
    const contact = await createContact(finance, { workspaceId: "ws-crm", accountId: account.id, email: "recipient@public.test", name: "Recipient" });
    const document = await fixture.prisma.document.create({ data: { workspaceId: "ws-crm", title: "Full prompt context", textContent: "Private drafting facts", accessDomain: "FINANCE" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
    const lineageRoots = await captureArtifactInputProof(finance, "ws-crm", [{ kind: "Document", id: document.id }], fixture.prisma);
    const result = await createCommunicationSuggestion(finance, { workspaceId: "ws-crm", contactId: contact.id,
      title: "Draft", subject: "Recap", bodyMd: "Private drafted body", source: "workspace-chat", lineageRoots });
    expect(result).toMatchObject({ recipientEmail: contact.email, recipientName: contact.name });
    expect(await listCommunicationSuggestions(general, "ws-crm")).toMatchObject({ total: 0 });
    const edited = await updateCommunicationSuggestion(finance, { workspaceId: "ws-crm", suggestionId: result.id, title: "Reviewed draft" });
    expect(edited.title).toBe("Reviewed draft");
    expect(await failCommunicationSuggestion(finance, { workspaceId: "ws-crm", suggestionId: result.id, failureReason: "Human reviewed failure" })).toMatchObject({ status: "FAILED" });
    expect(await requestCommunicationSuggestionExecution(finance, { workspaceId: "ws-crm", suggestionId: result.id })).toMatchObject({ status: "REQUESTED" });
    const sent = await markCommunicationSuggestionSent(finance, { workspaceId: "ws-crm", suggestionId: result.id });
    expect(sent).toMatchObject({ status: "SENT", title: "Reviewed draft" });
    const activity = fixture.tables.crmActivity.at(-1);
    expect(activity).toMatchObject({ title: "Recap", bodyMd: "Private drafted body", source: "communication_suggestion" });
    expect(await readableArtifactIds(finance, "ws-crm", "CrmActivity", [activity], fixture.prisma)).toEqual(new Set([activity.id]));
    expect(await readableArtifactIds(general, "ws-crm", "CrmActivity", [activity], fixture.prisma)).toEqual(new Set());
    const activityReceipt = fixture.tables.artifactInputLineage.find((receipt) => receipt.artifactType === "CrmActivity" && receipt.artifactId === activity.id);
    expect(activityReceipt.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ArtifactInputSnapshot" }), expect.objectContaining({ kind: "Document", id: document.id })]));
    expect(activityReceipt.rootsJson).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "CrmCommunicationSuggestion", id: result.id })]));
    await markCommunicationSuggestionSent(finance, { workspaceId: "ws-crm", suggestionId: result.id });
    expect(fixture.tables.crmActivity).toHaveLength(1);
    fixture.tables.document[0].archivedAt = fixture.time;
    expect(await listCommunicationSuggestions(finance, "ws-crm")).toMatchObject({ total: 0 });
    expect(await readableArtifactIds(finance, "ws-crm", "CrmActivity", [activity], fixture.prisma)).toEqual(new Set());
    expect(fixture.tables.crmCommunicationSuggestion[0].bodyMd).toBe("Private drafted body");
    expect(fixture.prisma.$queryRaw).toHaveBeenCalled();
  });

  it("withholds uncaptured suggestions, preserves unknown edit history, and rejects stale or restricted recipient copies", async () => {
    const account = await createCrmAccount(finance, { workspaceId: "ws-crm", name: "Public account" });
    const contact = await createContact(finance, { workspaceId: "ws-crm", accountId: account.id, email: "recipient@public.test", name: "Recipient" });
    const unknown = await createCommunicationSuggestion(finance, { workspaceId: "ws-crm", contactId: contact.id,
      title: "Uncaptured draft", bodyMd: "Unknown old draft", source: "workspace-chat" });
    expect(unknown).toMatchObject({ contentWithheld: true, title: null, accountId: null });
    expect(await listCommunicationSuggestions(finance, "ws-crm")).toMatchObject({ total: 0 });
    const edited = await updateCommunicationSuggestion(finance, { workspaceId: "ws-crm", suggestionId: unknown.id, bodyMd: "Human amendment" });
    expect(edited).toMatchObject({ contentWithheld: true });
    const historical = fixture.tables.artifactInputSnapshot.find((snapshot) => snapshot.sourceId === unknown.id);
    expect(historical).toMatchObject({ origin: "UNKNOWN", contentJson: { bodyMd: "Unknown old draft" } });
    expect(await readableArtifactIds(finance, "ws-crm", "ArtifactInputSnapshot", [historical], fixture.prisma)).toEqual(new Set());
    await expect(markCommunicationSuggestionSent(finance, { workspaceId: "ws-crm", suggestionId: unknown.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.tables.crmActivity).toHaveLength(0);
    expect(await declineCommunicationSuggestion(finance, { workspaceId: "ws-crm", suggestionId: unknown.id })).toMatchObject({ contentWithheld: true, status: "DECLINED" });
    const document = await fixture.prisma.document.create({ data: { workspaceId: "ws-crm", title: "Private prompt", textContent: "Restricted input", accessDomain: "FINANCE" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
    const lineageRoots = await captureArtifactInputProof(finance, "ws-crm", [{ kind: "Document", id: document.id }], fixture.prisma);
    const restricted = await createContact(finance, { workspaceId: "ws-crm", accountId: account.id, email: "restricted@public.test", name: "Restricted recipient", lineageRoots });
    await expect(createCommunicationSuggestion(general, { workspaceId: "ws-crm", contactId: restricted.id, title: "Rejected", bodyMd: "New body" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.tables.document[0].textContent = "Prompt changed after generation";
    await expect(createCommunicationSuggestion(finance, { workspaceId: "ws-crm", contactId: contact.id,
      title: "Stale draft", bodyMd: "Draft from old context", source: "workspace-chat", lineageRoots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.crmCommunicationSuggestion).toHaveLength(1);
  });

  it("exports only public CRM source receipts, keeps status changes current and revokes stored packets live", async () => {
    const { createExecutionRequest, getExecutionPacket, getExecutionRequest } = await import("./execution-plumbing");
    await fixture.prisma.workspace.update({ where: { id: "ws-crm" }, data: { slug: "synthetic", name: "Synthetic workspace", description: "Public workspace context" } });
    const account = await createCrmAccount(finance, { workspaceId: "ws-crm", name: "Public recipient company" });
    const contact = await createContact(finance, { workspaceId: "ws-crm", accountId: account.id, email: "recipient@public.test", name: "Public recipient" });
    const suggestion = await createCommunicationSuggestion(finance, { workspaceId: "ws-crm", contactId: contact.id, title: "Reviewed public draft", bodyMd: "Native public draft" });
    const request = await createExecutionRequest(general, { workspaceId: "ws-crm", goal: "Send the reviewed public draft", writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: suggestion.id });
    expect(fixture.tables.crmCommunicationSuggestion[0].status).toBe("REQUESTED");
    expect(await readableArtifactIds(finance, "ws-crm", "CrmCommunicationSuggestion", [fixture.tables.crmCommunicationSuggestion[0]], fixture.prisma)).toEqual(new Set([suggestion.id]));
    await expect(getExecutionPacket(finance, { workspaceId: "ws-crm", requestId: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const packet = await getExecutionPacket(general, { workspaceId: "ws-crm", requestId: request.id });
    expect(packet).toMatchObject({ relevantContext: { relationshipCommunication: { bodyMd: "Native public draft" } } });
    expect(JSON.stringify(packet)).not.toContain("__crmInputReceipt");
    const source = await fixture.prisma.document.create({ data: { workspaceId: "ws-crm", title: "Finance-only source", textContent: "Restricted prompt", accessDomain: "FINANCE" } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: finance, workspaceId: "ws-crm", artifact: { kind: "Document", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    const lineageRoots = await captureArtifactInputProof(finance, "ws-crm", [{ kind: "Document", id: source.id }], fixture.prisma);
    const privateDraft = await createCommunicationSuggestion(finance, { workspaceId: "ws-crm", contactId: contact.id, title: "Private draft", bodyMd: "Private prompt output", source: "workspace-chat", lineageRoots });
    await expect(createExecutionRequest(finance, { workspaceId: "ws-crm", goal: "Do not export restricted context", writebackTargetType: "CRM_COMMUNICATION", writebackTargetId: privateDraft.id })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fixture.tables.executionRequest).toHaveLength(1);
    expect(fixture.tables.crmCommunicationSuggestion.find((row) => row.id === privateDraft.id).status).toBe("SUGGESTED");
    fixture.tables.crmContact.find((row) => row.id === contact.id).archivedAt = fixture.time;
    fixture.epochs.set(JSON.stringify(["ws-crm", "CrmContact", contact.id]), 1n);
    await expect(getExecutionPacket(general, { workspaceId: "ws-crm", requestId: request.id })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await expect(getExecutionRequest(general, { workspaceId: "ws-crm", requestId: request.id })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fixture.tables.crmCommunicationSuggestion[0].bodyMd).toBe("Native public draft");
  });
});
