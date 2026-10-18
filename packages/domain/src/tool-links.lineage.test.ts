import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === "memberships") { if (![...(tables.get("member")?.values() ?? [])].some(member => member.userId === row.id && matches(member, (value as any).some))) return false; }
      else if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "not" in value) { if (row[key] === value.not) return false; }
      else if (value && typeof value === "object" && "gt" in value) { if (!(row[key] > (value as any).gt)) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any, include: any = {}): any => {
    const result = structuredClone(row);
    const fields = select ?? include;
    for (const [key, request] of Object.entries(fields) as Array<[string, any]>) {
      if (key === "createdBy" || key === "user") {
        const user = tables.get("user")?.get(row[key === "createdBy" ? "createdByUserId" : "userId"]);
        result[key] = user ? project(user, request.select) : null;
      } else if (key === "circleTags") result.circleTags = (row.circleTags ?? []).map((tag: any) => ({ ...tag,
        ...(request.include?.circle ? { circle: structuredClone(tables.get("circle")?.get(tag.circleId)) } : {}),
      }));
    }
    return select ? Object.fromEntries(Object.keys(select).map(key => [key, result[key]])) : result;
  };
  const base = { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) };
  const prisma = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, include, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(Array.isArray(orderBy) ? Object.assign({}, ...orderBy) : orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select, include));
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null),
        findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        create: vi.fn(async ({ data, select, include }) => {
          const now = new Date();
          const row = { id: `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}),
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (name === "workspaceToolLink") {
            Object.assign(row, { archivedAt: null, archivedByUserId: null, archiveReason: null });
            row.circleTags = (data.circleTags?.create ?? []).map((tag: any, index: number) => ({ id: `tag-${serial}-${index}`, toolLinkId: row.id, circleId: tag.circleId, createdAt: now }));
          }
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return project(row, select, include);
        }),
        update: vi.fn(async ({ where, data, select, include }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return project(row, select, include);
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
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/crypto"), prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, actorUserIdForWorkspace: async (actor: AppActor) => actor.kind === "user" ? actor.user.id : undefined }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("./archive", () => ({ archiveFilterWhere: () => ({ archivedAt: null }), archiveWorkspaceArtifact: vi.fn() }));

import { AppError } from "./errors";
import { encryptSecret } from "../../shared/src/crypto";
import { mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof, inspectStoredArtifactInputDependencies, isArtifactInputProofReadable,
  isArtifactInputProofPubliclyShareable, recordArtifactInputLineage, withArtifactInputReadCapture } from "./source-lineage";
import { archiveWorkspaceToolLink, createWorkspaceToolLink, getWorkspaceToolLinkCredentialAccess, getWorkspaceToolLinkInputRoots,
  listWorkspaceToolLinks, revealWorkspaceToolLinkCredential, updateWorkspaceToolLink } from "./tool-links";
import { archiveWorkspaceArtifact } from "./archive";
import { recordConversationToolLinkArchiveOutcome, getConversationOperationOutcomeInputRoots, getConversationOperationOutcomeInputReceipt,
  readConversationToolLinkArchiveOutcome } from "./conversation-operation-outcome";
import { withMcpToolInput } from "./mcp-tool-input";

const workspaceId = "ws";
const alpha: AppActor = { kind: "user", user: { id: "alpha", email: "alpha@example.test", displayName: "Alpha" } };
const beta: AppActor = { kind: "user", user: { id: "beta", email: "beta@example.test", displayName: "Beta" } };
const tx = fixture.prisma as any;
function insert(table: string, row: { id: string; [key: string]: any }) {
  const data: { id: string; [key: string]: any } = { createdAt: new Date("2026-10-13T12:00:00Z"), updatedAt: new Date("2026-10-13T12:00:00Z"), ...(["document", "brainSource", "meeting"].includes(table) ? { informationCategory: "GENERAL" } : {}), ...row };
  if (!fixture.tables.has(table)) fixture.tables.set(table, new Map()); fixture.tables.get(table)!.set(data.id, data);
  return data;
}
function rows(table: string): any[] { return [...(fixture.tables.get(table)?.values() ?? [])]; }
function credential(scopes = ["tools:read", "tools:write", "tools:credentials:read"]) {
  const row = insert("agentCredential", { id: "credential", workspaceId, tokenHash: "synthetic-token-hash", scopes, isActive: true });
  const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic credential", credentialId: row.id,
    credentialVersion: mcpCredentialVersion(row.tokenHash), workspaceIds: [workspaceId], scopes: [...row.scopes] };
  return { row, actor };
}
async function original() { return createWorkspaceToolLink(alpha, { workspaceId, title: "Known fixture tool", url: "https://example.test", credentialLabel: "Fixture access", credentialSecret: "synthetic-only" }); }
async function certify(kind: "Circle" | "WorkspaceToolLink" | "Document", row: any) {
  return recordArtifactInputLineage({ tx, actor: alpha, workspaceId, artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
}

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear();
  fixture.base.$queryRaw.mockReset().mockResolvedValue([]);
  fixture.base.$executeRaw.mockReset().mockResolvedValue(1);
  installSourcePermissionEpochFixture(fixture.prisma);
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const before = structuredClone(fixture.tables);
    try { return await callback(tx); } catch (error) { fixture.tables.clear(); for (const [key, data] of before) fixture.tables.set(key, data); throw error; }
  });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    if (ws !== workspaceId) throw new AppError(403, "NOT_A_MEMBER", "Synthetic workspace unavailable.");
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "NOT_A_MEMBER", "Synthetic workspace unavailable."); return null; }
    const member = rows("member").find(row => row.userId === actor.user.id && row.workspaceId === ws && row.isActive);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable.");
    return member;
  });
  vi.mocked(archiveWorkspaceArtifact).mockImplementation(async (_actor, params) => {
    const row = fixture.tables.get("workspaceToolLink")!.get(params.entityId);
    row.archivedAt = new Date();
    return { ...row };
  });
  insert("workspace", { id: workspaceId, name: "Synthetic workspace" });
  for (const id of ["alpha", "beta"]) {
    insert("user", { id, email: `${id}@example.test`, displayName: id, bio: null, avatarUrl: null, linkedinUrl: null, websiteUrl: null });
    insert("member", { id: `member-${id}`, workspaceId, userId: id, role: "CONTRIBUTOR", isActive: true });
  }
});

// All source gates, receipt constructors, crypto and producer lineage are real.
describe("ToolLink complete native lineage with synthetic SQL", () => {
  it("records newly authored originals atomically and rejects unknown legacy metadata and secrets", async () => {
    const created = await original();
    expect(created).toMatchObject({ title: "Known fixture tool", hasCredential: true });
    expect(rows("artifactInputLineage")[0]).toMatchObject({ artifactType: "WorkspaceToolLink", origin: "HUMAN_ORIGINAL", rootsJson: [] });
    const stored = rows("workspaceToolLink")[0];
    expect(stored.credentialSecretEnc).not.toContain("synthetic-only");
    insert("workspaceToolLink", { ...stored, id: "unknown", title: "Unknown fixture name" });
    expect((await listWorkspaceToolLinks(alpha, { workspaceId })).map(row => row.id)).toEqual([created.id]);
    await expect(getWorkspaceToolLinkCredentialAccess(alpha, { workspaceId, toolLinkId: "unknown" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(updateWorkspaceToolLink(alpha, { workspaceId, toolLinkId: "unknown", title: "Cannot promote" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(rows("workspaceToolLink").find(row => row.id === "unknown").title).toBe("Unknown fixture name");
  });

  it("proves scalar tag identities and separate complete Circle labels without raw relation mismatch", async () => {
    const circle = insert("circle", { id: "circle", workspaceId, name: "Fixture circle", archivedAt: null });
    await certify("Circle", circle);
    const created = await createWorkspaceToolLink(alpha, { workspaceId, title: "Tagged fixture", url: "https://example.test", circleIds: [circle.id] });
    expect(created.circles).toEqual([{ id: circle.id, name: circle.name }]);
    const roots = await getWorkspaceToolLinkInputRoots(alpha, workspaceId, created);
    expect(roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Circle", id: circle.id })]));
    const stored = rows("workspaceToolLink")[0];
    stored.circleTags[0].circleId = "retagged";
    expect(await isArtifactInputProofReadable(alpha, workspaceId, roots)).toBe(false);
  });

  it("preserves copied prior versions while rejecting source changes and body laundering", async () => {
    const created = await original();
    const input = insert("document", { id: "input", workspaceId, title: "Fixture driver", accessDomain: "WORKSPACE", archivedAt: null, textContent: "Native context" });
    await certify("Document", input);
    const roots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Document", id: input.id }]);
    const updated = await withArtifactInputReadCapture(alpha, workspaceId, () => updateWorkspaceToolLink(alpha,
      { workspaceId, toolLinkId: created.id, title: "Derived fixture", lineageRoots: roots }), { preserveConsumedRevisions: true });
    expect(updated.value.title).toBe("Derived fixture");
    expect(rows("artifactInputSnapshot").some(row => row.sourceKind === "WorkspaceToolLink" && row.contentJson.title === "Known fixture tool")).toBe(true);
    const manifest = rows("artifactInputLineage").at(-1);
    expect(manifest.origin).toBe("DERIVED");
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Document", id: input.id }), expect.objectContaining({ kind: "ArtifactInputSnapshot" })]));
    input.archivedAt = new Date();
    expect(await listWorkspaceToolLinks(alpha, { workspaceId })).toEqual([]);
    await expect(updateWorkspaceToolLink(alpha, { workspaceId, toolLinkId: created.id, title: "Cannot launder" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(rows("workspaceToolLink")[0].title).toBe("Derived fixture");
  });

  it("requires creator or current secret-manager role and gates decryption with actual exact blob proof", async () => {
    const created = await original();
    await expect(revealWorkspaceToolLinkCredential(beta, { workspaceId, toolLinkId: created.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    fixture.tables.get("member")!.get("member-beta").role = "FACILITATOR";
    await expect(revealWorkspaceToolLinkCredential(beta, { workspaceId, toolLinkId: created.id })).resolves.toMatchObject({ credentialSecret: "synthetic-only" });
    const proof = await captureArtifactInputProof(beta, workspaceId, [{ kind: "WorkspaceToolLinkCredential", id: created.id }]);
    expect(await isArtifactInputProofPubliclyShareable(beta, workspaceId, proof)).toBe(false);
    fixture.tables.get("member")!.get("member-beta").role = "CONTRIBUTOR";
    expect(await isArtifactInputProofReadable(beta, workspaceId, proof)).toBe(false);
  });

  it("requires an exact live explicit credential principal and never grants secrets to bare agents", async () => {
    const created = await original();
    const granted = credential();
    const proof = await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "WorkspaceToolLinkCredential", id: created.id }]);
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, proof)).toBe(true);
    const bare: AppActor = { kind: "agent", authProvider: "bootstrap", label: "Fixture", workspaceIds: [workspaceId] };
    await expect(getWorkspaceToolLinkCredentialAccess(bare, { workspaceId, toolLinkId: created.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect((await listWorkspaceToolLinks(bare, { workspaceId }))[0]?.canManageCredentials).toBe(false);
    const liveCredential = fixture.tables.get("agentCredential")!.get(granted.row.id);
    liveCredential.tokenHash = "rotated-synthetic-token";
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, proof)).toBe(false);
    liveCredential.tokenHash = "synthetic-token-hash";
    liveCredential.scopes = ["tools:read", "tools:write"];
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, proof)).toBe(false);
  });

  it("keeps immutable credential copies private and tied to the full parent metadata proof", async () => {
    const created = await original();
    const frozen = await captureArtifactInputSnapshotProof(alpha, workspaceId, { kind: "WorkspaceToolLinkCredential", id: created.id }, tx);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, frozen)).toBe(true);
    expect(await isArtifactInputProofPubliclyShareable(alpha, workspaceId, frozen)).toBe(false);
    rows("workspaceToolLink")[0].descriptionMd = "Unproved direct body mutation";
    expect(await isArtifactInputProofReadable(alpha, workspaceId, frozen)).toBe(false);
  });

  it("permits only the secret projection with the sensitive scope and embeds parent history through repeated freezing", async () => {
    const created = await original();
    const granted = credential(["tools:credentials:read", "context-graph:read"]);
    await expect(revealWorkspaceToolLinkCredential(granted.actor, { workspaceId, toolLinkId: created.id }))
      .resolves.toEqual({ credentialLabel: "Fixture access", credentialSecret: "synthetic-only" });
    const direct = await captureArtifactInputProof(granted.actor, workspaceId,
      [{ kind: "WorkspaceToolLinkCredential", id: created.id }], tx);
    const frozen = await captureImmutableArtifactInputProof(granted.actor, workspaceId, direct, tx);
    const frozenAgain = await captureImmutableArtifactInputProof(granted.actor, workspaceId, frozen, tx);
    expect(frozenAgain).toHaveLength(1);
    const receipt = fixture.tables.get("artifactInputSnapshot")!.get(frozenAgain[0].id);
    expect(receipt.sourceKind).toBe("WorkspaceToolLinkCredential");
    expect(receipt.rootsJson).toHaveLength(1);
    expect(fixture.tables.get("artifactInputSnapshot")!.get(receipt.rootsJson[0].id).sourceKind).toBe("WorkspaceToolLink");
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, frozenAgain, tx)).toBe(true);
    const graph = insert("contextGraphObject", { id: "credential-projection-graph", workspaceId,
      title: "Synthetic secret projection", properties: { secret: "synthetic-only" }, archivedAt: null });
    await recordArtifactInputLineage({ tx, actor: granted.actor, workspaceId,
      artifact: { kind: "ContextGraphObject", id: graph.id }, content: graph,
      origin: "DERIVED", inputs: [], inheritedRoots: frozenAgain });
    const manifest = rows("artifactInputLineage").at(-1);
    expect(manifest.rootsJson).toHaveLength(1);
    expect(await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "ContextGraphObject", id: graph.id }], tx)).toHaveLength(2);
    expect(await isArtifactInputProofPubliclyShareable(granted.actor, workspaceId, frozenAgain, tx)).toBe(false);
    rows("workspaceToolLink")[0].credentialSecretEnc = encryptSecret("rotated-synthetic-only");
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, frozenAgain, tx)).toBe(false);
  });

  it("never lends a credential parent's scope exception to a generic root in either proof order", async () => {
    const created = await original();
    const granted = credential(["tools:credentials:read"]);
    const secret = await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "WorkspaceToolLinkCredential", id: created.id }], tx);
    const metadata = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "WorkspaceToolLink", id: created.id }], tx);
    for (const roots of [[...secret, ...metadata], [...metadata, ...secret]]) {
      expect(await isArtifactInputProofReadable(granted.actor, workspaceId, roots, tx)).toBe(false);
    }
    const frozen = await captureImmutableArtifactInputProof(granted.actor, workspaceId, secret, tx);
    const stored = fixture.tables.get("artifactInputSnapshot")!.get(frozen[0].id);
    const parentRoot = stored.rootsJson[0];
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, [parentRoot], tx)).toBe(false);
    expect(await isArtifactInputProofReadable(granted.actor, workspaceId, [...frozen, parentRoot], tx)).toBe(false);
  });

  it("freezes a direct secret input before persistence and retains its complete parent dependencies", async () => {
    const created = await original();
    const granted = credential(["tools:credentials:read", "context-graph:read"]);
    const secret = await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "WorkspaceToolLinkCredential", id: created.id }], tx);
    const inspected = await inspectStoredArtifactInputDependencies(tx, workspaceId, secret);
    expect(inspected.complete).toBe(true);
    expect(inspected.roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "WorkspaceToolLink", id: created.id })]));
    const graph = insert("contextGraphObject", { id: "direct-secret-graph", workspaceId, title: "Synthetic secret value",
      properties: { secret: "synthetic-only" }, archivedAt: null });
    const manifest = await recordArtifactInputLineage({ tx, actor: granted.actor, workspaceId,
      artifact: { kind: "ContextGraphObject", id: graph.id }, content: graph, origin: "DERIVED", inputs: [], inheritedRoots: secret });
    expect(manifest.rootsJson).toHaveLength(1);
    expect((manifest.rootsJson as any[])[0].kind).toBe("ArtifactInputSnapshot");
    expect(await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "ContextGraphObject", id: graph.id }], tx)).toHaveLength(2);
    const frozenDependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, manifest.rootsJson as any);
    expect(frozenDependencies.complete).toBe(true);
    expect(frozenDependencies.roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "WorkspaceToolLink", id: created.id })]));
    const legacy = rows("artifactInputLineage").find(row => row.id === manifest.id);
    legacy.rootsJson = secret;
    await expect(captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "ContextGraphObject", id: graph.id }], tx))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("still requires every upstream source of the full credential parent", async () => {
    const created = await original();
    const document = insert("document", { id: "secret-parent-document", workspaceId, title: "Synthetic contributor",
      contentMd: "Synthetic private input", accessDomain: "WORKSPACE", archivedAt: null });
    await certify("Document", document);
    const link = rows("workspaceToolLink")[0];
    await recordArtifactInputLineage({ tx, actor: alpha, workspaceId,
      artifact: { kind: "WorkspaceToolLink", id: created.id }, content: link,
      origin: "DERIVED", inputs: [{ kind: "Document", id: document.id }] });
    const granted = credential(["tools:credentials:read"]);
    await expect(revealWorkspaceToolLinkCredential(granted.actor, { workspaceId, toolLinkId: created.id }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.tables.get("agentCredential")!.get(granted.row.id).scopes.push("brain:read");
    const currentActor = { ...granted.actor, scopes: ["tools:credentials:read", "brain:read"] } as AppActor;
    await expect(revealWorkspaceToolLinkCredential(currentActor, { workspaceId, toolLinkId: created.id }))
      .resolves.toMatchObject({ credentialSecret: "synthetic-only" });
    fixture.tables.get("document")!.get(document.id).archivedAt = new Date();
    await expect(revealWorkspaceToolLinkCredential(currentActor, { workspaceId, toolLinkId: created.id }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("captures model/MCP raw credential parameters as ciphertext with actual submission roots", async () => {
    // The response includes the workspace identity as an independently proved input.
    const granted = credential(["workspace:read", "tools:read", "tools:write", "tools:credentials:read"]);
    const origin = { kind: "agent" as const, id: granted.row.id, workspaceId,
      credentialVersion: granted.actor.kind === "agent" ? granted.actor.credentialVersion : "",
      scopeHash: mcpScopesHash(granted.row.scopes), requiredScopes: [] };
    const created = await runWithMcpOrigin(origin, () => withMcpToolInput(granted.actor, {
      workspaceId, toolName: "upsert_tool_link", requiredScopes: ["tools:write"],
      args: { title: "MCP fixture", url: "https://example.test", credentialSecret: "synthetic-only" },
    }, args => createWorkspaceToolLink(granted.actor, { workspaceId, ...args })));
    expect(rows("mcpToolInput")[0].argumentsJson).not.toContain("synthetic-only");
    expect(rows("workspaceToolLink")[0].credentialSecretEnc).not.toContain("synthetic-only");
    expect(rows("artifactInputLineage").at(-1)).toMatchObject({ origin: "DERIVED", rootsJson: [expect.objectContaining({ kind: "McpToolInput" })] });
    await expect(getWorkspaceToolLinkInputRoots(granted.actor, workspaceId, created)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "McpToolInput" })]));
    granted.row.isActive = false;
    await expect(getWorkspaceToolLinkInputRoots(granted.actor, workspaceId, created)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});


async function nativeRequest(actor = alpha) {
  const input = insert("conversationIngressInput", { id: "native-request", workspaceId, actorKind: "user",
    userId: actor.kind === "user" ? actor.user.id : null, credentialId: null, credentialVersion: null, scopeHash: null,
    content: "Archive the selected fixture tool." });
  return captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationIngressInput", id: input.id }]);
}

describe("Committed archive outcome with actual source checks", () => {
  it("commits independent native outcome while the old body and model context become unreadable", async () => {
    const link = await original();
    const bodyRoots = await getWorkspaceToolLinkInputRoots(alpha, workspaceId, link);
    const requestRoots = await nativeRequest();
    const result = await archiveWorkspaceToolLink(alpha, { workspaceId, toolLinkId: link.id,
      lineageRoots: [...bodyRoots, ...requestRoots], requestLineageRoots: requestRoots });
    expect(result).toEqual({ success: true, message: "The tool link was archived." });
    expect(JSON.stringify(result)).not.toContain(link.id);
    const roots = await getConversationOperationOutcomeInputRoots(alpha, workspaceId, result);
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ConversationIngressInput", id: "native-request" }),
      expect.objectContaining({ kind: "ConversationOperationOutcome" }),
    ]));
    expect(roots.some(root => root.kind === "WorkspaceToolLink")).toBe(false);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, bodyRoots)).toBe(false);
    expect(await isArtifactInputProofPubliclyShareable(alpha, workspaceId, roots)).toBe(false);
    const stored = rows("conversationOperationOutcome")[0];
    expect(stored).toMatchObject({ operation: "TOOL_LINK_ARCHIVED", actorKind: "user", userId: "alpha", requiredScopes: ["tools:write"] });
    expect(stored.requestKey).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toHaveProperty("toolLinkId");
    expect(stored).not.toHaveProperty("title");
  });

  it("replays the exact native request without duplicate archive and rejects result/principal substitution", async () => {
    const link = await original();
    const requestRoots = await nativeRequest();
    const params = { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots };
    const first = await archiveWorkspaceToolLink(alpha, params);
    const second = await archiveWorkspaceToolLink(alpha, params);
    expect(second).toEqual(first);
    expect(archiveWorkspaceArtifact).toHaveBeenCalledOnce();
    expect(rows("conversationOperationOutcome")).toHaveLength(1);
    expect(getConversationOperationOutcomeInputReceipt({ ...second })).toBeUndefined();
    await expect(getConversationOperationOutcomeInputRoots(beta, workspaceId, second)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(getConversationOperationOutcomeInputRoots(alpha, "foreign-ws", second)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    if ("success" in second) second.message = "Changed" as any;
    await expect(getConversationOperationOutcomeInputRoots(alpha, workspaceId, second)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("keeps replay identity stable across exact immutable native request snapshots", async () => {
    const link = await original();
    const requestRoots = await nativeRequest();
    await archiveWorkspaceToolLink(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots });
    const frozen = await captureArtifactInputSnapshotProof(alpha, workspaceId, requestRoots[0]!, tx);
    const result = await readConversationToolLinkArchiveOutcome(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: frozen });
    expect(result).toEqual({ success: true, message: "The tool link was archived." });
    expect(archiveWorkspaceArtifact).toHaveBeenCalledOnce();
    expect(rows("conversationOperationOutcome")).toHaveLength(1);
  });

  it("never mints an operation outcome from an invented success or model/body receipt", async () => {
    const link = await original();
    const requestRoots = await nativeRequest();
    await expect(recordConversationToolLinkArchiveOutcome(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots }, tx)).rejects.toMatchObject({ code: "OPERATION_NOT_COMMITTED" });
    const bodyRoots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "WorkspaceToolLink", id: link.id }]);
    await expect(archiveWorkspaceToolLink(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: bodyRoots })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(archiveWorkspaceArtifact).not.toHaveBeenCalled();
    expect(rows("conversationOperationOutcome")).toHaveLength(0);
  });

  it("rolls archive and outcome back together if outcome lineage cannot commit", async () => {
    const link = await original();
    const requestRoots = await nativeRequest();
    const originalCreate = tx.artifactInputLineage.create.getMockImplementation();
    tx.artifactInputLineage.create.mockImplementationOnce(async () => { throw new Error("Synthetic receipt persistence failure"); });
    await expect(archiveWorkspaceToolLink(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots })).rejects.toThrow("Synthetic receipt persistence failure");
    tx.artifactInputLineage.create.mockImplementation(originalCreate);
    expect(rows("workspaceToolLink")[0].archivedAt).toBeNull();
    expect(rows("conversationOperationOutcome")).toHaveLength(0);
    expect(rows("artifactInputLineage")).toHaveLength(1);
  });

  it("revokes native acknowledgment when original request access or membership changes", async () => {
    const link = await original();
    const requestRoots = await nativeRequest();
    const result = await archiveWorkspaceToolLink(alpha, { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots });
    fixture.tables.get("conversationIngressInput")!.get("native-request").userId = "beta";
    await expect(getConversationOperationOutcomeInputRoots(alpha, workspaceId, result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    fixture.tables.get("conversationIngressInput")!.get("native-request").userId = "alpha";
    fixture.tables.get("member")!.get("member-alpha").isActive = false;
    await expect(getConversationOperationOutcomeInputRoots(alpha, workspaceId, result)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("bounds credential operation acknowledgment to its current native scopes and token version", async () => {
    const link = await original();
    const granted = credential();
    const input = insert("mcpToolInput", { id: "credential-request", workspaceId, actorKind: "agent", userId: null,
      credentialId: granted.row.id, credentialVersion: mcpCredentialVersion(granted.row.tokenHash), scopeHash: mcpScopesHash(granted.row.scopes),
      toolName: "archive_tool_link", argumentsJson: encryptSecret(JSON.stringify({ toolLinkId: link.id })), requiredScopes: ["tools:write"] });
    const requestRoots = await captureArtifactInputProof(granted.actor, workspaceId, [{ kind: "McpToolInput", id: input.id }]);
    const result = await archiveWorkspaceToolLink(granted.actor, { workspaceId, toolLinkId: link.id, requestLineageRoots: requestRoots });
    await expect(getConversationOperationOutcomeInputRoots(granted.actor, workspaceId, result)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ConversationOperationOutcome" })]));
    granted.row.scopes = ["tools:read"];
    await expect(getConversationOperationOutcomeInputRoots(granted.actor, workspaceId, result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    granted.row.scopes = ["tools:read", "tools:write", "tools:credentials:read"];
    granted.row.tokenHash = "rotated-fixture-token";
    await expect(getConversationOperationOutcomeInputRoots(granted.actor, workspaceId, result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
