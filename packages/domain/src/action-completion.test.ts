import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "NOT") { if ((Array.isArray(value) ? value : [value]).some((entry: any) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "not" in value) { if (row[key] === value.not) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (value && typeof value === "object") { if (!matches(row[key], value)) return false; }
      else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any): any => select ? Object.fromEntries(Object.keys(select).map((key) => [key, typeof select[key] === "object" && row[key] ? project(row[key], select[key].select) : row[key]])) : structuredClone(row);
  const base = { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) };
  const prisma: any = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null),
        findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}),
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(name);
  } });
  return { tables, memberships, delegates, membership, prisma, base };
});

vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/crypto"), prisma: fixture.prisma, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));
const nativeReplay = vi.hoisted(() => ({sdk: vi.fn(async () => ({structuredContent: {results: []}}))}));
vi.mock("./external-mcp", async original => ({...await original(), readExternalMcpNativeToolResult: nativeReplay.sdk}));

import { assertMcpOriginActive, getMcpOrigin, mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "../../shared/src/mcp-context";
import { AppError } from "./errors";
import { decryptSecret, encryptSecret } from "../../shared/src/crypto";
import { withMcpToolInput } from "./mcp-tool-input";
import { completeActionWithNativeRequest, getActionCompletionOutcomeInputRoots, isActionCompletionOutcomeReadable,
  isActionCompletionPublicNoteReadable, ACTION_COMPLETION_PUBLIC_NOTE } from "./action-completion";
import { prepareActionCompletionLineage } from "./action-completion-lineage";

import { captureArtifactInputProof, captureArtifactPermissionEpochs, isArtifactInputProofReadable,
  lineageContentFingerprint, readableArtifactIds, recordArtifactInputLineage, withArtifactInputReadCapture } from "./source-lineage";
import { externalMcpConnectionGrantHash, externalMcpNativeReadRequest } from "./external-mcp";
import { externalMcpResponseHash } from "./external-mcp-response-input";
import { capturePermissionEpochs } from "./source-permission-epochs";
vi.mock("./audit-trail", () => ({recordAudit: vi.fn(async () => undefined)}));
vi.mock("./events", () => ({appendEvents: vi.fn(async () => undefined)}));

const workspaceId = "synthetic-ws-a";
const alice: AppActor = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } };
// A Prisma transaction client has no $transaction method. Keep that shape so
// OAuth epoch checks retain their lock on this same synthetic connection.
const tx = new Proxy(fixture.prisma, { get(target, property) {
  return property === "$transaction" ? undefined : Reflect.get(target, property);
} }) as any;
let oauthEpochs: ReturnType<typeof installSourcePermissionEpochFixture>;
const payload = {actionId: "action-one", completedVia: "  Current native completion note canary  "};
const params = {workspaceId, toolName: "complete_action", args: payload, requiredScopes: ["actions:write"]};
function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: any } = { createdAt: new Date(), ...(["document", "brainSource", "meeting"].includes(delegate) ? { informationCategory: "GENERAL" } : {}), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map()); fixture.tables.get(delegate)!.set(row.id, row); return row;
}
function oauth(actor = alice, ws = workspaceId, id = "oauth-alice") {
  const row = insert("mcpOAuthAccessToken", { id, workspaceId: ws, userId: actor.kind === "user" ? actor.user.id : "", revokedAt: null,
    scopes: ["actions:write"], client: { isActive: true }, refreshExpiresAt: null });
  oauthEpochs.bump(ws, "McpOAuthGrantPolicy", id);
  return { row, origin: { kind: "oauth" as const, id, workspaceId: ws, scopeHash: mcpScopesHash(row.scopes), grantEpoch: "1", requiredScopes: [] } };
}
function credential(id = "credential-a", ws = workspaceId) {
  const row = insert("agentCredential", { id, workspaceId: ws, tokenHash: `synthetic-token-${id}`, scopes: ["actions:write"], isActive: true });
  const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic credential", credentialId: id, credentialVersion: mcpCredentialVersion(row.tokenHash), workspaceIds: [ws], scopes: [...row.scopes] };
  return { row, actor, origin: { kind: "agent" as const, id, workspaceId: ws, credentialVersion: mcpCredentialVersion(row.tokenHash), scopeHash: mcpScopesHash(row.scopes), requiredScopes: [] } };
}
function inputs() { return [...(fixture.tables.get("mcpToolInput")?.values() ?? [])]; }

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear();
  oauthEpochs = installSourcePermissionEpochFixture(fixture.prisma);
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR" });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    const origin = getMcpOrigin(); if (origin) await assertMcpOriginActive(tx, origin, ws);
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "FORBIDDEN", "Synthetic workspace unavailable"); return null; }
    const member = fixture.memberships.get(`${ws}:${actor.user.id}`);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return member;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    try { return await callback(tx); } catch (error) { fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows); throw error; }
  });
});

const now = new Date("2026-10-13T10:00:00.000Z");
async function originalAction(known = true) {
  insert("member", {id: "human-assignee", workspaceId, userId: "synthetic-alice", isActive: true, kind: "HUMAN", role: "CONTRIBUTOR", user: {email: "alice@example.test", displayName: "Synthetic human"}});
  const row = insert("action", {id: payload.actionId, workspaceId, title: "Original title canary", bodyMd: "Original body canary",
    createdAt: now, updatedAt: now, version: 1, status: "OPEN", isPrivate: false, archivedAt: null, publishedAt: now,
    authorUserId: "synthetic-alice", assigneeMemberId: "human-assignee", duplicateOfActionId: null, completedVia: null});
  if (known) await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Action", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
  return row;
}
const manifests = () => [...(fixture.tables.get("artifactInputLineage")?.values() ?? [])].filter(row => row.artifactType === "Action");
function complete(actor: AppActor, origin: Parameters<typeof runWithMcpOrigin>[0], args = payload) {
  return runWithMcpOrigin(origin, () => withMcpToolInput(actor, {...params, args}, () => completeActionWithNativeRequest(actor, {workspaceId, ...args})));
}

describe("native Action completion control", () => {
  it("returns only committed status under a write-only grant, preserving old body and complete note provenance", async () => {
    await originalAction();
    const old = structuredClone(manifests()[0]);
    const principal = credential();
    const result = await complete(principal.actor, principal.origin);
    expect(result).toEqual({id: payload.actionId, status: "COMPLETED"});
    expect(JSON.stringify(result)).not.toMatch(/canary|title|body|completedVia/);
    expect(await isArtifactInputProofReadable(principal.actor, workspaceId, [{kind: "Action", id: payload.actionId, fingerprint: manifests().at(-1).contentHash}], tx)).toBe(false);
    const snapshot = [...fixture.tables.get("artifactInputSnapshot")!.values()][0];
    expect(snapshot.contentJson.bodyMd).toBe("Original body canary");
    expect(snapshot.permissionEpochsJson).toEqual(old.permissionEpochsJson);
    const latest = manifests().at(-1);
    expect(latest.origin).toBe("DERIVED");
    expect(latest.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({kind: "ArtifactInputSnapshot"}),
      expect.objectContaining({kind: "ConversationOperationOutcome"})]));
    expect(latest.rootsJson).not.toEqual(expect.arrayContaining([expect.objectContaining({kind: "McpToolInput"})]));
    const publicNote = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    expect(publicNote).toMatchObject({actorKind: "public", userId: null, credentialId: null, requiredScopes: [],
      controlJson: {completedVia: payload.completedVia.trim(), audience: "ACTION_READERS", publicationPolicyVersion: 1}});
    expect(publicNote.controlJson).not.toHaveProperty("bodyMd");
    expect(decryptSecret(inputs()[0].argumentsJson)).toBe(JSON.stringify(payload));
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({kind: "ConversationOperationOutcome"})]));
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, {...result})).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
  });

  it("publishes the typed note to current Action readers without binding its visibility to the editor credential", async () => {
    await originalAction(); const principal = credential();
    await complete(principal.actor, principal.origin);
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const bob: AppActor = {kind: "user", user: {id: "synthetic-bob", email: "bob@example.test", displayName: null}};
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(true);
    expect(await isActionCompletionPublicNoteReadable(bob, "synthetic-ws-b", note, tx)).toBe(false);
    principal.row.isActive = false;
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(true);
    const action = fixture.tables.get("action")!.get(payload.actionId);
    action.isPrivate = true; oauthEpochs.bump(workspaceId, "Action", action.id);
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
    action.isPrivate = false; oauthEpochs.bump(workspaceId, "Action", action.id);
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
  });

  it("preserves the existing brain:read Action source alternative for OAuth and agent readers", async () => {
    await originalAction(); const editor = credential();
    await complete(editor.actor, editor.origin);
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const bob: AppActor = {kind: "user", user: {id: "synthetic-bob", email: "bob@example.test", displayName: null}};
    const delegated = oauth(bob, workspaceId, "oauth-bob-reader");
    delegated.row.scopes = ["brain:read"];
    delegated.origin.scopeHash = mcpScopesHash(delegated.row.scopes);
    expect(await runWithMcpOrigin(delegated.origin,
      () => isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx))).toBe(true);
    const agent = credential("credential-reader");
    agent.row.scopes = ["brain:read"];
    agent.actor.scopes = [...agent.row.scopes];
    agent.origin.scopeHash = mcpScopesHash(agent.row.scopes);
    expect(await runWithMcpOrigin(agent.origin,
      () => isActionCompletionPublicNoteReadable(agent.actor, workspaceId, note, tx))).toBe(true);
    delegated.row.scopes = [];
    expect(await runWithMcpOrigin(delegated.origin,
      () => isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx))).toBe(false);
  });

  it("withholds the public projection if its exact private submitted bytes or note control change", async () => {
    await originalAction(); const principal = credential();
    await complete(principal.actor, principal.origin);
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const bob: AppActor = {kind: "user", user: {id: "synthetic-bob", email: "bob@example.test", displayName: null}};
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(true);
    note.controlJson.completedVia = "Forged public note";
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
    note.controlJson.completedVia = payload.completedVia.trim();
    const originalSnapshotId = note.controlJson.oldActionSnapshotId;
    note.controlJson.oldActionSnapshotId = "different-old-revision";
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
    note.controlJson.oldActionSnapshotId = originalSnapshotId;
    const noteManifest = [...fixture.tables.get("artifactInputLineage")!.values()]
      .find(row => row.artifactType === "ConversationOperationOutcome" && row.artifactId === note.id);
    const originalProof = structuredClone(noteManifest.permissionEpochsJson);
    noteManifest.permissionEpochsJson.entries = noteManifest.permissionEpochsJson.entries.filter((entry: {kind: string}) => entry.kind !== "Action");
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
    noteManifest.permissionEpochsJson = originalProof;
    const input = inputs()[0];
    input.toolName = "read_private_chat";
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
  });

  it.each([false, true])("keeps unknown or previously revoked body withheld while completing native status (stale=%j)", async stale => {
    await originalAction(stale);
    if (stale) oauthEpochs.bump(workspaceId, "Action", payload.actionId);
    const principal = credential();
    await expect(complete(principal.actor, principal.origin)).resolves.toEqual({id: payload.actionId, status: "COMPLETED"});
    expect(manifests().at(-1).origin).toBe("UNKNOWN");
    expect(manifests().at(-1).rootsJson).toEqual([]);
    expect([...fixture.tables.get("artifactInputSnapshot")!.values()][0].contentJson.bodyMd).toBe("Original body canary");
  });

  it.each([false, true])("requires an original Document epoch in copied Action history (leaf proof=%j)", async leafProof => {
    const action = await originalAction();
    const document = insert("document", {id: "copied-document", workspaceId, title: "Copied document",
      textContent: "Copied body canary", accessDomain: "WORKSPACE", source: "SYNTHETIC",
      storageKey: "synthetic", archivedAt: null});
    await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Document", id: document.id},
      content: document, origin: "HUMAN_ORIGINAL", inputs: []});
    action.bodyMd = document.textContent;
    await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Action", id: action.id},
      content: action, origin: "DERIVED", inputs: [{kind: "Document", id: document.id}]});
    const copied = manifests().at(-1);
    expect(copied.permissionEpochsJson.entries).toEqual(expect.arrayContaining([expect.objectContaining({kind: "Document", id: document.id})]));
    if (leafProof) copied.rootsJson[0].permissionEpochs = structuredClone(copied.permissionEpochsJson);
    copied.permissionEpochsJson.entries = copied.permissionEpochsJson.entries.filter((entry: {kind: string}) => entry.kind !== "Document");
    const principal = credential();
    await expect(complete(principal.actor, principal.origin)).resolves.toEqual({id: action.id, status: "COMPLETED"});
    expect(manifests().at(-1).origin).toBe(leafProof ? "DERIVED" : "UNKNOWN");
    document.accessDomain = "FINANCE"; oauthEpochs.bump(workspaceId, "Document", document.id);
    document.accessDomain = "WORKSPACE"; oauthEpochs.bump(workspaceId, "Document", document.id);
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const bob: AppActor = {kind: "user", user: {id: "synthetic-bob", email: "bob@example.test", displayName: null}};
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(false);
  });

  it("binds a newly proven original revision without redeeming an older ambiguous same-body receipt", async () => {
    const action = await originalAction();
    manifests()[0].inputsJson = [{kind: "Document", id: "legacy-malformed-original"}];
    await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Action", id: action.id},
      content: action, origin: "HUMAN_ORIGINAL", inputs: []});
    const valid = manifests().at(-1);
    const principal = credential();
    await complete(principal.actor, principal.origin);
    const snapshot = [...fixture.tables.get("artifactInputSnapshot")!.values()][0];
    expect(snapshot.accessEnvelopeJson).toMatchObject({humanOriginalManifestId: valid.id,
      humanOriginalManifestRevision: valid.revision});
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const bob: AppActor = {kind: "user", user: {id: "synthetic-bob", email: "bob@example.test", displayName: null}};
    expect(await isActionCompletionPublicNoteReadable(bob, workspaceId, note, tx)).toBe(true);
  });

  it.each([{toolName: "update_action", args: payload}, {toolName: "complete_action", args: {...payload, actionId: "other-action"}},
    {toolName: "complete_action", args: {...payload, privateDraft: "Private chat canary"}},
    {toolName: "complete_action", args: {...payload, completedVia: "Different original note"}}])("rejects a different native tool/id/note before changing status", async supplied => {
    await originalAction(); const principal = credential();
    await expect(runWithMcpOrigin(principal.origin, () => withMcpToolInput(principal.actor, {...params, ...supplied},
      () => completeActionWithNativeRequest(principal.actor, {workspaceId, ...payload})))).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(fixture.tables.get("action")!.get(payload.actionId).status).toBe("OPEN");
  });

  it("rejects a forged full before row even inside an authenticated native request", async () => {
    const row = await originalAction(); const principal = credential();
    await expect(runWithMcpOrigin(principal.origin, () => withMcpToolInput(principal.actor, params,
      () => prepareActionCompletionLineage(principal.actor, {workspaceId, ...payload}, {...row, bodyMd: "Forged body"} as any, tx))))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(fixture.tables.get("artifactInputSnapshot")?.size ?? 0).toBe(0);
  });

  it.each([{isPrivate: true}, {status: "COMPLETED"}, {archivedAt: now}, {duplicateOfActionId: "other"}, {assigneeMemberId: null}])("rejects unsupported current control state %j", async changes => {
    const row = await originalAction(); Object.assign(row, changes); const principal = credential();
    await expect(complete(principal.actor, principal.origin)).rejects.toBeDefined();
    expect(fixture.tables.get("conversationOperationOutcome")?.size ?? 0).toBe(0);
  });

  it.each([{kind: "SYSTEM"}, {isActive: false}, {user: {email: "support+synthetic@example.test", displayName: "Synthetic"}}])("requires an active human assignee %j", async changes => {
    await originalAction(); Object.assign(fixture.tables.get("member")!.get("human-assignee"), changes); const principal = credential();
    await expect(complete(principal.actor, principal.origin)).rejects.toMatchObject({code: "INVALID_INPUT"});
    expect(fixture.tables.get("action")!.get(payload.actionId).status).toBe("OPEN");
  });

  it("rolls the action, old snapshots, and new manifests back if native outcome commit fails", async () => {
    await originalAction(); const principal = credential();
    fixture.prisma.conversationOperationOutcome.create.mockRejectedValueOnce(new Error("Synthetic native fact commit failure"));
    await expect(complete(principal.actor, principal.origin)).rejects.toThrow("Synthetic native fact commit failure");
    expect(fixture.tables.get("action")!.get(payload.actionId).status).toBe("OPEN");
    expect(fixture.tables.get("artifactInputSnapshot")?.size ?? 0).toBe(0);
    expect(manifests()).toHaveLength(1);
  });

  it("revokes the registered native acknowledgment after token rotation or action generation change", async () => {
    await originalAction(); const principal = credential(); const result = await complete(principal.actor, principal.origin);
    principal.row.tokenHash = "rotated-token";
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
    principal.row.tokenHash = "synthetic-token-credential-a";
    fixture.tables.get("action")!.get(payload.actionId).updatedAt = new Date("2026-10-13T11:00:00Z");
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
  });

  it("checks the current ambient OAuth command consent on native fact reads", async () => {
    await originalAction(); const grant = oauth(); const result = await complete(alice, grant.origin);
    const outcome = [...fixture.tables.get("conversationOperationOutcome")!.values()][0];
    grant.row.scopes = [];
    await expect(runWithMcpOrigin(grant.origin, () => isActionCompletionOutcomeReadable(alice, workspaceId, outcome, tx))).resolves.toBe(false);
    grant.row.scopes = ["actions:write"];
    await expect(runWithMcpOrigin({...grant.origin, grantEpoch: "0"}, () => isActionCompletionOutcomeReadable(alice, workspaceId, outcome, tx))).resolves.toBe(false);
    expect(result).toEqual({id: payload.actionId, status: "COMPLETED"});
  });
  it("binds native status receipts to the exact principal/workspace and exact current request", async () => {
    await originalAction(); const principal = credential(); const result = await complete(principal.actor, principal.origin);
    const other = credential("credential-b");
    await expect(getActionCompletionOutcomeInputRoots(other.actor, workspaceId, result)).rejects.toBeDefined();
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, "synthetic-ws-b", result)).rejects.toBeDefined();
    await expect(runWithMcpOrigin(principal.origin, () => withMcpToolInput(principal.actor, params, async () => result)))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(fixture.prisma.action.update).toHaveBeenCalledOnce();
  });

  it("seals the submitted completion fields before the first asynchronous check", async () => {
    await originalAction(); const principal = credential();
    const result = await runWithMcpOrigin(principal.origin, () => withMcpToolInput(principal.actor, params, () => {
      const request = {workspaceId, ...payload};
      const completing = completeActionWithNativeRequest(principal.actor, request);
      request.actionId = "unsubmitted-action"; request.completedVia = "Unsubmitted note";
      return completing;
    }));
    expect(result.id).toBe(payload.actionId);
    expect(fixture.tables.get("action")!.get(payload.actionId).completedVia).toBe(payload.completedVia.trim());
  });

  it("does not revive a native acknowledgment after permission revoke and restore", async () => {
    await originalAction(); const principal = credential(); const result = await complete(principal.actor, principal.origin);
    const row = fixture.tables.get("action")!.get(payload.actionId);
    row.isPrivate = true; oauthEpochs.bump(workspaceId, "Action", row.id);
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
    row.isPrivate = false; oauthEpochs.bump(workspaceId, "Action", row.id);
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
  });

  it("retains an unrecognized historical manifest and its epoch evidence without promoting it", async () => {
    await originalAction(); const old = fixture.tables.get("artifactInputLineage")!.values().next().value!;
    old.contentHash = "0".repeat(64); old.rootsJson = [{kind: "BrainArticle", id: "unknown-original", fingerprint: "1".repeat(64)}];
    const original = structuredClone(old); const principal = credential();
    await complete(principal.actor, principal.origin);
    const snapshot = [...fixture.tables.get("artifactInputSnapshot")!.values()][0];
    expect(snapshot.origin).toBe("UNKNOWN");
    expect(snapshot.rootsJson).toEqual(original.rootsJson);
    expect(snapshot.permissionEpochsJson).toEqual(original.permissionEpochsJson);
    expect(manifests().at(-1).origin).toBe("UNKNOWN");
    expect(manifests()[0]).toEqual(original);
  });

  it("does not revive a native acknowledgment after assigned membership revoke and restore", async () => {
    await originalAction(); const principal = credential(); const result = await complete(principal.actor, principal.origin);
    const member = fixture.tables.get("member")!.get("human-assignee");
    member.isActive = false; oauthEpochs.bump(workspaceId, "Member", member.id);
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
    member.isActive = true; oauthEpochs.bump(workspaceId, "Member", member.id);
    await expect(getActionCompletionOutcomeInputRoots(principal.actor, workspaceId, result)).rejects.toBeDefined();
  });

  it("attests the completion note in complete Action reads even when its timestamp is unchanged", async () => {
    await originalAction(); const principal = credential();
    principal.row.scopes = ["actions:write", "actions:read"];
    principal.actor = {...principal.actor, scopes: [...principal.row.scopes]};
    principal.origin.scopeHash = mcpScopesHash(principal.row.scopes);
    await complete(principal.actor, principal.origin);
    const bodyProof = await captureArtifactInputProof(principal.actor, workspaceId, [{kind: "Action", id: payload.actionId}], tx);
    expect(await isArtifactInputProofReadable(principal.actor, workspaceId, bodyProof, tx)).toBe(true);
    const row = fixture.tables.get("action")!.get(payload.actionId);
    const timestamp = row.updatedAt;
    row.completedVia = "Unproved replacement note";
    expect(row.updatedAt).toBe(timestamp);
    expect(await isArtifactInputProofReadable(principal.actor, workspaceId, bodyProof, tx)).toBe(false);
  });

});

describe("public note nested native read fence", () => {
  it.each(["proof", "capture", "list"] as const)("rechecks the entire closure after nested MCP replay in %s", async api => {
    const response = {structuredContent: {results: []}};
    nativeReplay.sdk.mockResolvedValue(response);
    const action = await originalAction();
    const connection = insert("externalMcpConnection", {id: "note-connection", workspaceId, userId: alice.user.id,
      status: "ACTIVE", providerKey: "notion", serverUrl: "https://mcp.notion.com/mcp", providerAccountId: null,
      scopes: ["read"], accessTokenEnc: "synthetic-unused", updatedAt: now});
    const request = externalMcpNativeReadRequest("notion", "SEARCH", {query: "SYNTHETIC_PUBLIC_NOTE_CONTEXT", limit: 1});
    const originalLocalEpochsJson = await capturePermissionEpochs(tx, workspaceId, [
      {kind: "Workspace", id: workspaceId}, {kind: "MemberUserPolicy", id: alice.user.id},
      {kind: "WorkspaceSupportPolicy", id: alice.user.id}, {kind: "ExternalMcpConnection", id: connection.id},
      {kind: "ExternalMcpConnectionSetPolicy", id: alice.user.id}, {kind: "ExternalMcpResponseInput", id: "note-native"}]);
    const native = insert("externalMcpResponseInput", {id: "note-native", workspaceId, connectionId: connection.id,
      localUserId: alice.user.id, providerKey: "notion", serverUrl: request.serverUrl, providerAccountId: null,
      mode: "SEARCH", toolName: request.toolName, requestJson: request.arguments,
      encryptedResponseJson: encryptSecret(JSON.stringify(response)), responseHash: externalMcpResponseHash(response),
      connectionGrantHash: externalMcpConnectionGrantHash(connection as any), originalLocalEpochsJson, fetchedAt: now});
    const nativeRoot = {kind: "ExternalMcpResponseInput" as const, id: native.id,
      fingerprint: lineageContentFingerprint("ExternalMcpResponseInput", native), permissionEpochs: originalLocalEpochsJson};
    const actionProof = await captureArtifactPermissionEpochs(alice, workspaceId,
      [{kind: "Action", id: action.id, fingerprint: lineageContentFingerprint("Action", action)}, nativeRoot], tx);
    await tx.artifactInputLineage.create({data: {workspaceId, artifactType: "Action", artifactId: action.id,
      revision: 2, origin: "DERIVED", contentHash: lineageContentFingerprint("Action", action), inputsJson: [],
      rootsJson: [nativeRoot], epochProofVersion: 1, permissionEpochsJson: actionProof}});
    const editor = credential();
    await complete(editor.actor, editor.origin);
    const note = [...fixture.tables.get("conversationOperationOutcome")!.values()]
      .find(row => row.operation === ACTION_COMPLETION_PUBLIC_NOTE);
    const document = insert("document", {id: "independent-note-document", workspaceId, title: "Independent",
      textContent: "Independent body", accessDomain: "WORKSPACE", archivedAt: null});
    await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Document", id: document.id},
      content: document, origin: "HUMAN_ORIGINAL", inputs: []});
    const roots = [{kind: "Document" as const, id: document.id, fingerprint: lineageContentFingerprint("Document", document)},
      {kind: "ConversationOperationOutcome" as const, id: note.id,
        fingerprint: lineageContentFingerprint("ConversationOperationOutcome", note)}];
    const account = insert("crmAccount", {id: "note-union-account", workspaceId, name: "Synthetic union", archivedAt: null});
    const unionProof = await captureArtifactPermissionEpochs(alice, workspaceId,
      [{kind: "CrmAccount", id: account.id, fingerprint: lineageContentFingerprint("CrmAccount", account)}, ...roots], tx);
    await tx.artifactInputLineage.create({data: {workspaceId, artifactType: "CrmAccount", artifactId: account.id,
      revision: 1, origin: "DERIVED", contentHash: lineageContentFingerprint("CrmAccount", account),
      inputsJson: [], rootsJson: roots, epochProofVersion: 1, permissionEpochsJson: unionProof}});
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, fixture.prisma)).toBe(true);
    nativeReplay.sdk.mockClear();
    nativeReplay.sdk.mockImplementationOnce(async () => {
      document.accessDomain = "FINANCE";
      oauthEpochs.bump(workspaceId, "Document", document.id);
      return response;
    });
    if (api === "proof") expect(await isArtifactInputProofReadable(alice, workspaceId, roots, fixture.prisma)).toBe(false);
    else if (api === "capture") await expect(captureArtifactInputProof(alice, workspaceId, roots, fixture.prisma))
      .rejects.toMatchObject({code: "SOURCE_CHANGED"});
    else {
      const survivor = insert("crmAccount", {id: "independent-survivor", workspaceId, name: "Survivor", archivedAt: null});
      await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "CrmAccount", id: survivor.id},
        content: survivor, origin: "HUMAN_ORIGINAL", inputs: []});
      const observed = await withArtifactInputReadCapture(alice, workspaceId, async () =>
        readableArtifactIds(alice, workspaceId, "CrmAccount", [account, survivor], fixture.prisma));
      expect(observed.value).toEqual(new Set([survivor.id]));
      expect(observed.roots).toEqual([expect.objectContaining({kind: "CrmAccount", id: survivor.id})]);
    }
    expect(nativeReplay.sdk).toHaveBeenCalled();
  });
});
