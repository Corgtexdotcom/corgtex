import { vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { LineageKind } from "../../../domain/src/source-lineage";
import { installSourcePermissionEpochFixture } from "../../../domain/src/source-permission-epochs.test-fixture";

// Synthetic SQL interpreter; receipt, source-permission and runtime code remain real.
export const fixture = (() => {
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-12T10:00:00Z");
  const names = ["informationCategoryPolicy", "workspace", "user", "member", "document", "action", "tension", "proposal", "meeting", "meetingInsight",
    "modelUsageBudget", "modelUsage", "notification", "constitution", "constitutionSourceReference", "policyCorpus", "brainArticle", "checkIn", "brainSource", "conversationSession", "conversationTurn", "conversationPromptInput", "agentIdentity", "artifactInputLineage", "artifactInputSnapshot", "agentRun", "agentStep", "agentToolCall", "event"];
  const relatedKind: Record<string, string> = { user: "user", meeting: "meeting", member: "member", ownerMember: "member", agentRun: "agentRun", conversation: "conversationSession", session: "conversationSession" };
  function relation(row: any, key: string) {
    return rows[relatedKind[key]]?.find((item) => item.id === row[key + "Id"]);
  }
  function matches(row: any, where: any): boolean {
    return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (["workspaceId_category", "workspaceId_agentKey", "workspaceId_userId"].includes(key)) return matches(row, value);
      if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
      if (key === "OR") return value.some((part: any) => matches(row, part));
      if (key === "NOT") return !matches(row, value);
      if (key === "memberships") return rows.member.some((member) => member.userId === row.id && matches(member, value.some));
      if (relatedKind[key]) return matches(relation(row, key), value);
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        if ("notIn" in value) return !value.notIn.includes(row[key]);
        if ("gt" in value) return row[key] > value.gt;
        if ("gte" in value) return row[key] >= value.gte;
        if ("not" in value) return row[key] !== value.not;
        throw new Error(`Unsupported synthetic predicate ${key}`);
      }
      return row[key] === value;
    });
  }
  function project(row: any, args: any = {}): any {
    if (!row) return null;
    const result = { ...row };
    for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
      if (relatedKind[key]) result[key] = project(relation(row, key), request === true ? {} : request);
      else if (key === "sourceReferences") result[key] = rows.constitutionSourceReference.filter((reference) => reference.constitutionId === row.id).sort((a, b) => a.pointOrder - b.pointOrder || a.sourceOrder - b.sourceOrder).map((reference) => project(reference, request));
      else if (key === "turns") result[key] = rows.conversationTurn.filter((turn) => turn.conversationId === row.id).sort((a, b) => a.sequenceNumber - b.sequenceNumber).map((turn) => project(turn, request));
      else throw new Error(`Unsupported synthetic include ${key}`);
    }
    return args.select ? Object.fromEntries(Object.entries(args.select).map(([key, request]: [string, any]) =>
      [key, relatedKind[key] ? project(relation(row, key), request) : result[key]])) : result;
  }
  function stored(name: string, data: any) {
    return { id: `${name}-${rows[name].length}`, createdAt: timestamp,
      ...(!["user", "member", "workspace", "modelUsageBudget", "modelUsage", "notification", "constitution", "constitutionSourceReference", "policyCorpus", "brainArticle", "checkIn", "brainSource", "agentRun", "agentStep", "agentToolCall"].includes(name) ? { updatedAt: timestamp } : {}),
      ...(["brainSource", "document", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}),
      ...(name === "brainSource" ? { accessDomain: "WORKSPACE", archivedAt: null } : {}),
      ...(name === "conversationSession" ? { status: "ACTIVE" } : {}),
      ...(name === "agentRun" ? { contextJson: {}, resultJson: null } : {}),
      ...(name === "checkIn" ? { status: "OPEN", metadata: null, relatedEntityType: null, relatedEntityId: null,
        relatedConversationId: null, responseMd: null, sentiment: null, respondedAt: null } : {}), ...data };
  }
  const prisma: any = { $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []) };
  for (const name of names) {
    rows[name] = [];
    prisma[name] = {
      findFirst: vi.fn(async (args: any) => {
        const found = rows[name].filter((row) => matches(row, args.where));
        return project(name === "artifactInputLineage" ? found.at(-1) : found[0], args);
      }),
      findUnique: vi.fn(async (args: any) => project(rows[name].find((row) => matches(row, args.where)), args)),
      findUniqueOrThrow: vi.fn(async (args: any) => { const row = rows[name].find((item) => matches(item, args.where)); if (!row) throw new Error("Synthetic record missing"); return project(row, args); }),
      findMany: vi.fn(async (args: any) => {
        const ordered = rows[name].filter((row) => matches(row, args.where))
          .sort((a, b) => name === "artifactInputLineage" ? b.revision - a.revision : a.id.localeCompare(b.id));
        const start = args.cursor ? ordered.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : args.skip ?? 0;
        return ordered.slice(start, start + (args.take ?? ordered.length)).map((row) => project(row, args));
      }),
      groupBy: vi.fn(async (args: any) => {
        const groups = new Map<string, any[]>();
        for (const row of rows[name].filter((item) => matches(item, args.where))) {
          const key = JSON.stringify(args.by.map((field: string) => row[field]));
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        const result: Record<string, any>[] = [...groups.values()].map((group) => ({
          ...Object.fromEntries(args.by.map((field: string) => [field, group[0][field]])),
          ...(args._max ? { _max: Object.fromEntries(Object.keys(args._max).map((field) =>
            [field, group.reduce((max, row) => max == null || row[field] > max ? row[field] : max, null)])) } : {}),
          ...(args._count ? { _count: args._count === true ? group.length : Object.fromEntries(Object.keys(args._count).map((field) =>
            [field, field === "_all" ? group.length : group.filter((row) => row[field] != null).length])) } : {}),
        }));
        const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
        result.sort((a, b) => {
          for (const part of order) for (const [field, direction] of Object.entries(part)) {
            if (a[field] !== b[field]) return (a[field] > b[field] ? 1 : -1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        });
        return result.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? result.length));
      }),
      count: vi.fn(async (args: any) => rows[name].filter((row) => matches(row, args.where)).length),
      create: vi.fn(async ({ data }: any) => { const row = stored(name, data); rows[name].push(row); return { ...row }; }),
      createMany: vi.fn(async ({ data }: any) => { for (const item of data) rows[name].push(stored(name, item)); return { count: data.length }; }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows[name].find((item) => matches(item, where));
        if (!row) throw new Error(`Missing synthetic ${name}`);
        Object.assign(row, data); return { ...row };
      }),
    };
  }
  prisma.$transaction = vi.fn(async (run: any) => {
    const before = structuredClone(rows);
    try { return await run(prisma); }
    catch (error) { for (const name of names) rows[name] = before[name]; throw error; }
  });
  const domains = new Map<string, string[]>();
  const membership = vi.fn(async ({ actor, workspaceId }: any) => {
    if (actor.kind === "agent") {
      if (!actor.workspaceIds?.includes(workspaceId)) throw Object.assign(new Error("Workspace denied"), { code: "NOT_A_MEMBER" });
      return null;
    }
    const member = rows.member.find((row) => row.workspaceId === workspaceId && row.userId === actor.user.id && row.isActive);
    if (!member) throw Object.assign(new Error("Member denied"), { code: "NOT_A_MEMBER" });
    return member;
  });
  const chat = vi.fn(async (_input: any) => ({ content: "Synthetic inbox summary", usage: { model: "synthetic", inputTokens: 2, outputTokens: 3 } }));
  function add(name: string, data: any) { const row = stored(name, data); rows[name].push(row); return row; }
  function manifest(kind: string, id: string) { return rows.artifactInputLineage.filter((row) => row.artifactType === kind && row.artifactId === id).at(-1); }
  function sources(kind: string, id: string) {
    const roots = manifest(kind, id)?.rootsJson;
    const ids = new Set<string>();
    if (Array.isArray(roots)) for (const root of roots) {
      if (root.kind === "ArtifactInputSnapshot") {
        const snapshot = rows.artifactInputSnapshot.find((row) => row.id === root.id);
        if (snapshot) ids.add(`${snapshot.sourceKind}:${snapshot.sourceId}`);
      } else ids.add(`${root.kind}:${root.id}`);
    }
    return ids;
  }
  return { prisma, rows, timestamp, domains, membership, chat, add, manifest, sources };
})();

export const workspaceId = "ws-a";
export const alpha = { kind: "user", user: { id: "alpha", email: "alpha@example.test", displayName: "Alpha" } } as AppActor;
export const beta = { kind: "user", user: { id: "beta", email: "beta@example.test", displayName: "Beta" } } as AppActor;
export const sharedEnv = { AGENT_KILL_SWITCH: false, WORKSPACE_AGENT_MAX_CONCURRENCY: 1000 };

export async function resetFixture() {
  for (const name of Object.keys(fixture.rows)) fixture.rows[name] = [];
  fixture.domains.clear(); fixture.domains.set("alpha", ["WORKSPACE"]); fixture.domains.set("beta", ["WORKSPACE", "FINANCE"]);
  vi.clearAllMocks();
  installSourcePermissionEpochFixture(fixture.prisma);
  fixture.chat.mockImplementation(async () => ({ content: "Synthetic inbox summary", usage: { model: "synthetic", inputTokens: 2, outputTokens: 3 } }));
  fixture.add("workspace", { id: workspaceId, name: "Synthetic workspace" });
  fixture.add("workspace", { id: "ws-b", name: "Foreign workspace" });
  for (const [id, label] of [["alpha", "Alpha"], ["beta", "Beta"]]) {
    fixture.add("user", { id, email: `${id}@example.test`, displayName: label, bio: null, avatarUrl: null, linkedinUrl: null, websiteUrl: null });
    fixture.add("member", { id: `member-${id}`, workspaceId, userId: id, role: "CONTRIBUTOR", kind: "HUMAN", isActive: true, joinedAt: fixture.timestamp });
  }
}
export async function known(kind: LineageKind, row: any, inputs: Array<{ kind: LineageKind; id: string }> = [], actor = beta) {
  const { recordArtifactInputLineage } = await import("../../../domain/src/source-lineage");
  return recordArtifactInputLineage({ tx: fixture.prisma, actor, workspaceId: row.workspaceId ?? workspaceId,
    artifact: { kind, id: row.id }, content: row, origin: inputs.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs });
}
/** A new copied document retains the exact independently authored source and domain. */
export async function knownCopiedDocument(row: any, actor = beta) {
  const source = fixture.add("brainSource", { id: `original-${row.id}`, workspaceId: row.workspaceId,
    sourceType: "ARTICLE", channel: "manual", tier: "reference", title: row.title, content: row.textContent,
    accessDomain: row.accessDomain, authorMemberId: actor.kind === "user" ? `member-${actor.user.id}` : null,
    ingestionGuidanceMd: null, fileStorageKey: null, fileMimeType: null, metadata: null, archivedAt: null });
  await known("BrainSource", source, [], actor);
  await known("Document", row, [{ kind: "BrainSource", id: source.id }], actor);
  return source;
}
export async function domainExports() {
  return {
    ...await import("../../../domain/src/source-lineage"), ...await import("../../../domain/src/internal-source-principal"), ...await import("../../../domain/src/source-scoped-read"),
    ...await import("../../../domain/src/digest-lineage"), ...await import("../../../domain/src/errors"),
    ...await import("../../../domain/src/meeting-intelligence-context"), ...await import("../../../domain/src/check-ins"),
    isAgentEnabled: async () => true, getAgentModelOverride: async () => null, checkBudget: async () => ({ allowed: true }),
    resolveAgentIdentityLimits: async () => null,
    AGENT_REGISTRY: { "inbox-triage": { defaultModelTier: "light" }, "action-extraction": { defaultModelTier: "none" }, "daily-check-in": { defaultModelTier: "none" } },
  };
}
