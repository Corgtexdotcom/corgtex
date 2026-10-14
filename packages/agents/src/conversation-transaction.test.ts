import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const boundary = { rejectGlobal: false };
  function matches(row: any, where: any): boolean {
    if (!row) return false;
    return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (key === "AND") return value.every((entry: any) => matches(row, entry));
      if (key === "OR") return value.some((entry: any) => matches(row, entry));
      if (key === "conversation") return matches(tables.get("conversationSession")?.get(row.conversationId), value);
      if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
      if (value instanceof Date) return row[key]?.getTime() === value.getTime();
      return value === undefined || row[key] === value;
    });
  }
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const bases = { primary: { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn() }, tx: { $executeRaw: vi.fn(), $queryRaw: vi.fn() } };
  function client(name: "primary" | "tx"): any {
    return new Proxy(bases[name], { get(target, property) {
      if (name === "primary" && boundary.rejectGlobal) throw new Error(`Global database access forbidden: ${String(property)}`);
      if (property in target) return target[property as keyof typeof target];
      if (property === "$transaction") throw new Error("Nested transaction is unavailable");
      const table = String(property); const key = `${name}:${table}`;
      if (!delegates.has(key)) {
        const rows = () => [...(tables.get(table)?.values() ?? [])];
        const find = ({ where, select, take, orderBy }: any) => {
          let result = rows().filter((row) => matches(row, where));
          for (const [field, direction] of Object.entries(orderBy ?? {})) result.sort((a, b) => (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1) * (direction === "desc" ? -1 : 1));
          return result.slice(0, take ?? result.length).map((row) => project(row, select));
        };
        delegates.set(key, {
          findFirst: vi.fn(async (args) => find(args)[0] ?? null), findUnique: vi.fn(async (args) => find(args)[0] ?? null), findMany: vi.fn(async (args) => find(args)),
          create: vi.fn(async ({ data }) => {
            const row = { id: `${table}-${++serial}`, createdAt: new Date("2026-10-13T12:00:00Z"), ...(table === "brainSource" ? { accessDomain: "WORKSPACE" } : {}), ...structuredClone(data) };
            if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(row.id, row); return structuredClone(row);
          }),
          createMany: vi.fn(async ({ data }) => {
            if (!tables.has(table)) tables.set(table, new Map());
            for (const input of data) {
              const row = { id: `${table}-${++serial}`, createdAt: new Date("2026-10-13T12:00:00Z"), ...structuredClone(input) };
              tables.get(table)!.set(row.id, row);
            }
            return { count: data.length };
          }),
          update: vi.fn(async ({ where, data }) => {
            const row = rows().find((entry) => matches(entry, where)); if (!row) throw new Error("Synthetic row unavailable");
            Object.assign(row, structuredClone(data)); return structuredClone(row);
          }),
        });
      }
      return delegates.get(key);
    } });
  }
  const prisma = client("primary"); const tx = client("tx");
  return { tables, memberships, delegates, membership, bases, prisma, tx, boundary };
});

vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/mcp-context"), prisma: fixture.prisma, toInputJson: (value: unknown) => value,
  env: { MODEL_PROVIDER: "fake", MODEL_REQUEST_TIMEOUT_MS: 1000 } }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("../../domain/src/finance", () => ({ getFinanceAccessPolicy: vi.fn(async (_actor, _workspaceId, usedTx) => {
  if (fixture.boundary.rejectGlobal && usedTx !== fixture.tx) throw new Error("Global finance policy read forbidden");
  return { canRead: false };
}) }));
vi.mock("../../domain/src/role-onboarding", () => ({ updateRoleOnboardingStatusByConversation: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({ ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/conversation-lineage"),
  ...await import("../../domain/src/conversations"), ...await import("../../domain/src/conversation-ingress"),
  AppError: (await import("../../domain/src/errors")).AppError, buildRoleOnboardingContextWithLineageForConversation: vi.fn(async () => null) }));

import { AppError } from "../../domain/src/errors";
import { createConversationPromptInput, addConversationTurn } from "../../domain/src/conversations";
import { ingestConversationOnDemandInTransaction } from "../../domain/src/conversation-brain";
import { createConversationIngressInput } from "../../domain/src/conversation-ingress";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage, withArtifactInputWriteFence } from "../../domain/src/source-lineage";
import { mcpCredentialVersion } from "../../shared/src/mcp-context";
import { prepareConversationInputs } from "./conversation-inputs";

const workspaceId = "synthetic-ws-a";
const alice: AppActor = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } };
const bob: AppActor = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } };
const tx = fixture.tx as any;
const base = { actor: alice, workspaceId, sessionId: "session-alice", userId: "synthetic-alice", userMessage: "  Exact synthetic request\n" };
function insert(table: string, row: { id: string; [key: string]: unknown }) { if (!fixture.tables.has(table)) fixture.tables.set(table, new Map()); fixture.tables.get(table)!.set(row.id, row); return row; }
function size(table: string) { return fixture.tables.get(table)?.size ?? 0; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear(); fixture.boundary.rejectGlobal = false;
  for (const [ws, id] of [[workspaceId, "synthetic-alice"], [workspaceId, "synthetic-bob"], ["synthetic-ws-b", "synthetic-alice"]]) fixture.memberships.set(`${ws}:${id}`, { id: `member-${ws}-${id}`, role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws, tx: usedTx }) => {
    if (fixture.boundary.rejectGlobal && usedTx !== fixture.tx) throw new Error("Global membership read forbidden");
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return null; }
    const member = fixture.memberships.get(`${ws}:${actor.user.id}`); if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return member;
  });
  fixture.bases.primary.$transaction.mockImplementation(async (work) => {
    const saved = structuredClone(fixture.tables);
    try { return await work(tx); } catch (error) { fixture.tables.clear(); for (const [key, rows] of saved) fixture.tables.set(key, rows); throw error; }
  });
  insert("conversationSession", { id: base.sessionId, workspaceId, userId: base.userId, agentKey: "assistant", systemPrompt: null });
  insert("conversationSession", { id: "session-bob", workspaceId, userId: "synthetic-bob", agentKey: "assistant", systemPrompt: null });
  fixture.bases.tx.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.bases.tx.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(fixture.tx);
  fixture.bases.primary.$executeRaw.mockImplementation((...args) => fixture.bases.tx.$executeRaw(...args));
  fixture.bases.primary.$queryRaw.mockImplementation((...args) => fixture.bases.tx.$queryRaw(...args));
});

describe("conversation native inputs and turns in caller-owned transactions", () => {
  it("uses distinct caller tx for native constructors, grants, turn writes and all proof reads with global DB forbidden", async () => {
    expect(fixture.prisma).not.toBe(tx);
    fixture.boundary.rejectGlobal = true;
    try {
      const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
      const ingress = await createConversationIngressInput(alice, { workspaceId, content: base.userMessage, tx });
      const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }, { kind: "ConversationIngressInput", id: ingress.id }], tx);
      const turn = await addConversationTurn(alice, { workspaceId, conversationId: base.sessionId, promptInputId: prompt.id,
        userMessage: base.userMessage, assistantMessage: "Synthetic caller tx response", lineageRoots: roots, tx });
      const turnRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationTurn", id: turn.id }], tx);
      expect(await isArtifactInputProofReadable(alice, workspaceId, turnRoots, tx)).toBe(true);
      expect(fixture.membership.mock.calls.every(([params]) => params.tx === tx)).toBe(true);
    } finally { fixture.boundary.rejectGlobal = false; }
    expect(fixture.bases.primary.$transaction).not.toHaveBeenCalled();
  });

  it("uses the caller transaction for nested prospect target membership with every global read forbidden", async () => {
    const account = insert("crmAccount", { id: "synthetic-prospect-account", workspaceId, name: "Synthetic independent account", archivedAt: null });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmAccount", id: account.id }, content: account, origin: "HUMAN_ORIGINAL", inputs: [] });
    const prospect = insert("crmProspectWorkspace", { id: "synthetic-prospect", crmWorkspaceId: workspaceId, accountId: account.id,
      demoLeadId: null, targetWorkspaceId: "synthetic-ws-b", adminEmail: "alice@example.test", status: "PROVISIONED", provisionedAt: new Date() });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "CrmProspectWorkspace", id: prospect.id }, content: prospect, origin: "HUMAN_ORIGINAL", inputs: [] });
    fixture.membership.mockClear(); fixture.boundary.rejectGlobal = true;
    try {
      const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "CrmProspectWorkspace", id: prospect.id }], tx);
      expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(true);
      expect(fixture.membership.mock.calls.some(([params]) => params.workspaceId === "synthetic-ws-b" && params.tx === tx)).toBe(true);
      expect(fixture.membership.mock.calls.every(([params]) => params.tx === tx)).toBe(true);
      fixture.memberships.delete("synthetic-ws-b:synthetic-alice");
      expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(false);
    } finally { fixture.boundary.rejectGlobal = false; }
  });

  it("rejects model-originated publication even with complete private input roots and global DB forbidden", async () => {
    const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
    const lineageRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
    fixture.boundary.rejectGlobal = true;
    try {
      await expect(ingestConversationOnDemandInTransaction(tx, alice, {
        workspaceId, title: "Synthetic unconsented title", content: "Synthetic unconsented body", lineageRoots,
      })).rejects.toMatchObject({ code: "BRAIN_CONSENT_REQUIRED" });
      for (const table of ["brainSource", "auditLog", "event"]) expect(size(table)).toBe(0);
    } finally { fixture.boundary.rejectGlobal = false; }
    expect(fixture.bases.primary.$transaction).not.toHaveBeenCalled();
  });

  it("seals the exact caller actor before the first await without losing its object identity", async () => {
    const actor = structuredClone(alice);
    const authority = new WeakMap<object, string>([[actor, "synthetic-server-owned-authority"]]);
    const prompt = await createConversationPromptInput(actor, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
    const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
    fixture.membership.mockClear();
    const barrier = deferred();
    const pending = withArtifactInputWriteFence(async (usedTx) => {
      expect(usedTx).toBe(tx);
      await barrier.promise;
    }, () => addConversationTurn(actor, {
      workspaceId, conversationId: base.sessionId, promptInputId: prompt.id, userMessage: base.userMessage,
      assistantMessage: "Exact caller answer", lineageRoots: roots, tx,
    }));
    expect(Object.isFrozen(actor)).toBe(true);
    if (actor.kind !== "user") throw new Error("Synthetic user fixture");
    expect(Object.isFrozen(actor.user)).toBe(true);
    expect(() => { actor.user.id = "synthetic-bob"; }).toThrow(TypeError);
    expect(() => { (actor as any).kind = "agent"; }).toThrow(TypeError);
    barrier.resolve();
    const turn = await pending;
    expect(turn).toMatchObject({ conversationId: base.sessionId, promptInputId: prompt.id, assistantMessage: "Exact caller answer" });
    expect(fixture.membership.mock.calls.length).toBeGreaterThan(0);
    for (const [params] of fixture.membership.mock.calls) {
      expect(params.actor).toBe(actor);
      expect(authority.get(params.actor)).toBe("synthetic-server-owned-authority");
    }
    expect(await isArtifactInputProofReadable(actor, workspaceId,
      await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationTurn", id: turn.id }], tx), tx)).toBe(true);
  });

  it("reuses the supplied transaction for both constructors and exact source proofs", async () => {
    const fence = vi.fn(async (usedTx) => { expect(usedTx).toBe(tx); });
    const [prompt, ingress] = await withArtifactInputWriteFence(fence, async () => [
      await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx }),
      await createConversationIngressInput(alice, { workspaceId, content: base.userMessage, tx }),
    ]);
    expect(fixture.bases.primary.$transaction).not.toHaveBeenCalled(); expect(fence).toHaveBeenCalled();
    expect(fixture.prisma.conversationPromptInput.create).not.toHaveBeenCalled();
    expect(fixture.prisma.conversationIngressInput.create).not.toHaveBeenCalled();
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }, { kind: "ConversationIngressInput", id: ingress.id }], tx);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(true);
    expect(await isArtifactInputProofReadable(bob, workspaceId, roots, tx)).toBe(false);
    expect(await isArtifactInputProofReadable(alice, "synthetic-ws-b", roots, tx)).toBe(false);
    expect(prompt.content).toBe(base.userMessage); expect(ingress.content).toBe(base.userMessage);
  });

  it("reuses a committed prompt id and refuses different actor, session, workspace or content", async () => {
    const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
    const prepared = await prepareConversationInputs({ ...base, promptInputId: prompt.id });
    expect(prepared.promptInputId).toBe(prompt.id); expect(size("conversationPromptInput")).toBe(1); expect(fixture.prisma.conversationPromptInput.create).not.toHaveBeenCalled();
    for (const change of [{ actor: bob, userId: "synthetic-bob", sessionId: "session-bob" }, { sessionId: "session-bob" }, { workspaceId: "synthetic-ws-b" }, { userMessage: "Changed request" }]) {
      await expect(prepareConversationInputs({ ...base, ...change, promptInputId: prompt.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    }
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(prepareConversationInputs({ ...base, promptInputId: prompt.id })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(size("conversationPromptInput")).toBe(1);
  });

  it("reuses credential ingress only for its exact submitted content and current credential", async () => {
    const credential = insert("agentCredential", { id: "credential-a", workspaceId, tokenHash: "synthetic-token-a", scopes: ["conversations:write"], isActive: true });
    const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic conversation credential", credentialId: credential.id, credentialVersion: mcpCredentialVersion(String(credential.tokenHash)), workspaceIds: [workspaceId], scopes: ["conversations:write"] };
    const ingress = await createConversationIngressInput(actor, { workspaceId, content: base.userMessage, tx });
    const prepared = await prepareConversationInputs({ ...base, actor, requestSource: "MCP", ingressInputId: ingress.id });
    expect(prepared.ingressInputId).toBe(ingress.id); expect(prepared.promptInputId).toBeUndefined(); expect(size("conversationIngressInput")).toBe(1);
    await expect(prepareConversationInputs({ ...base, actor, requestSource: "MCP", ingressInputId: ingress.id, userMessage: "Changed request" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prepareConversationInputs({ ...base, actor: bob, userId: "synthetic-bob", requestSource: "MCP", ingressInputId: ingress.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    credential.isActive = false;
    await expect(prepareConversationInputs({ ...base, actor, requestSource: "MCP", ingressInputId: ingress.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.prisma.conversationIngressInput.create).not.toHaveBeenCalled(); expect(size("conversationIngressInput")).toBe(1);
  });

  it("captures the submitted prompt before the first membership await", async () => {
    const barrier = deferred(); fixture.membership.mockImplementationOnce(async () => { await barrier.promise; return { id: "member-alice", role: "CONTRIBUTOR" }; });
    const params = { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx };
    const pending = createConversationPromptInput(alice, params); params.content = "Mutated after submission"; barrier.resolve();
    expect((await pending).content).toBe(base.userMessage);
  });

  it("refuses switching the authenticated prompt principal and session during capture", async () => {
    const barrier = deferred(); fixture.membership.mockImplementationOnce(async () => { await barrier.promise; return { id: "member-alice", role: "CONTRIBUTOR" }; });
    const actor = structuredClone(alice); const params = { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx };
    const pending = createConversationPromptInput(actor, params); if (actor.kind !== "user") throw new Error("Synthetic user fixture");
    actor.user.id = "synthetic-bob"; params.conversationId = "session-bob"; barrier.resolve();
    await expect(pending).rejects.toThrow(); expect(size("conversationPromptInput")).toBe(0);
  });

  it("rolls back the native prompt with its request/job when enqueue fails", async () => {
    await expect(fixture.prisma.$transaction(async (usedTx: any) => {
      const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx: usedTx });
      await usedTx.agentRequest.create({ data: { workspaceId, promptInputId: prompt.id, prompt: base.userMessage, userId: base.userId } });
      await usedTx.workflowJob.create({ data: { workspaceId, type: "agent.run", payload: { promptInputId: prompt.id } } });
      throw new Error("Synthetic enqueue transaction rejected");
    })).rejects.toThrow("Synthetic enqueue transaction rejected");
    expect(size("conversationPromptInput")).toBe(0); expect(size("agentRequest")).toBe(0); expect(size("workflowJob")).toBe(0);
    expect(fixture.bases.primary.$transaction).toHaveBeenCalledTimes(1);
  });

  it("saves the exact final turn and complete receipt in the supplied completion transaction", async () => {
    const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
    const lineageRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
    const turn = await addConversationTurn(alice, { workspaceId, conversationId: base.sessionId, promptInputId: prompt.id, userMessage: base.userMessage,
      assistantMessage: "Synthetic final response", contextJson: { synthetic: true }, lineageRoots, tx });
    expect(turn.sequenceNumber).toBe(1); expect(turn.promptInputId).toBe(prompt.id);
    expect(fixture.bases.primary.$transaction).not.toHaveBeenCalled(); expect(fixture.bases.tx.$executeRaw).toHaveBeenCalled();
    const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationTurn", id: turn.id }], tx);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(true);
    const manifest = [...fixture.tables.get("artifactInputLineage")!.values()].find((row) => row.artifactId === turn.id);
    expect(manifest.origin).toBe("DERIVED"); expect(manifest.rootsJson).toEqual(expect.arrayContaining(lineageRoots));
  });

  it("rolls back the final turn and receipt when completion fails or the owner fence expires", async () => {
    const prompt = await createConversationPromptInput(alice, { workspaceId, conversationId: base.sessionId, content: base.userMessage, tx });
    const lineageRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationPromptInput", id: prompt.id }], tx);
    insert("workflowJob", { id: "synthetic-job", workspaceId, status: "RUNNING" });
    await expect(fixture.prisma.$transaction(async (usedTx: any) => {
      await addConversationTurn(alice, { workspaceId, conversationId: base.sessionId, promptInputId: prompt.id, userMessage: base.userMessage,
        assistantMessage: "Uncommitted final response", lineageRoots, tx: usedTx });
      await usedTx.workflowJob.update({ where: { id: "synthetic-job" }, data: { status: "COMPLETED" } });
      throw new Error("Synthetic completion rejected");
    })).rejects.toThrow("Synthetic completion rejected");
    expect(size("conversationTurn")).toBe(0); expect(size("artifactInputLineage")).toBe(0); expect(fixture.tables.get("workflowJob")!.get("synthetic-job").status).toBe("RUNNING");
    await expect(withArtifactInputWriteFence(async (usedTx) => { expect(usedTx).toBe(tx); throw new AppError(409, "OWNER_STALE", "Synthetic owner expired"); },
      () => addConversationTurn(alice, { workspaceId, conversationId: base.sessionId, promptInputId: prompt.id, userMessage: base.userMessage, assistantMessage: "Unreleased response", lineageRoots, tx }))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(size("conversationTurn")).toBe(0);
  });
});
