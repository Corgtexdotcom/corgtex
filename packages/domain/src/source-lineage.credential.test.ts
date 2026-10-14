import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";

const { db, authorize } = vi.hoisted(() => ({ db: {
  $executeRaw: vi.fn(), $queryRaw: vi.fn(), $transaction: vi.fn(),
  agentCredential: { findFirst: vi.fn() },
  brainArticle: { findFirst: vi.fn() }, action: { findFirst: vi.fn() }, document: { findFirst: vi.fn() },
  checkIn: { findFirst: vi.fn() }, modelUsage: { findFirst: vi.fn() },
  contextGraphObject: { findFirst: vi.fn() }, artifactInputSnapshot: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
}, authorize: vi.fn() }));
vi.mock("@corgtex/shared", async importOriginal => ({ ...await importOriginal<any>(), prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: authorize }));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: vi.fn(async () => ({ canRead: true })) }));
import { mcpCredentialVersion } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, lineageContentFingerprint, recordArtifactInputLineage, readableArtifactIds, type LineageKind, type LineageRoot } from "./source-lineage";

const date = new Date("2026-10-12T12:00:00Z");
let rows: Record<string, Record<string, any>>, manifests: any[];
const scopes = ["brain:read", "actions:read", "context-graph:read", "finance:read", "support:write"];
const credential = (id: string): AppActor => ({ kind: "agent", authProvider: "credential", label: "Owner's connector", credentialId: id,
  credentialVersion: mcpCredentialVersion(`synthetic-token-${id}`), workspaceIds: ["ws-1"], scopes: [...scopes] });
const owner: AppActor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: "Owner" } };
function root(kind: LineageKind, row: any): LineageRoot { return { kind, id: row.id, fingerprint: lineageContentFingerprint(kind, row) }; }
async function add(kind: LineageKind, row: any, roots: LineageRoot[] = [], origin: "HUMAN_ORIGINAL" | "DERIVED" = "HUMAN_ORIGINAL") {
  rows[kind] ??= {}; rows[kind][row.id] = row;
  await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1", artifact: { kind, id: row.id },
    content: row, origin, inputs: [], inheritedRoots: roots });
  return row;
}
beforeEach(() => {
  vi.resetAllMocks(); rows = {}; manifests = [];
  rows.AgentCredential = Object.fromEntries(["credential-a", "credential-b"].map(id => [id,
    { id, workspaceId: "ws-1", isActive: true, tokenHash: `synthetic-token-${id}`, scopes: [...scopes], createdByUserId: "owner" }]));
  db.agentCredential.findFirst.mockImplementation(async ({ where }) => {
    const grant = rows.AgentCredential[where.id];
    return grant?.workspaceId === where.workspaceId && grant.isActive === where.isActive ? grant : null;
  });
  authorize.mockImplementation(async ({ actor, workspaceId }) => {
    if (workspaceId !== "ws-1") throw new Error("Wrong workspace");
    return actor.kind === "user" ? { id: "owner-member", role: "ADMIN" } : null;
  });
  for (const [kind, delegate] of [["BrainArticle", "brainArticle"], ["Action", "action"], ["Document", "document"],
    ["CheckIn", "checkIn"], ["ModelUsageCost", "modelUsage"], ["ContextGraphObject", "contextGraphObject"], ["ArtifactInputSnapshot", "artifactInputSnapshot"]] as const) {
    db[delegate].findFirst.mockImplementation(async ({ where }) => rows[kind]?.[where.id]?.workspaceId === where.workspaceId ? rows[kind][where.id] : null);
  }
  db.artifactInputSnapshot.findMany.mockImplementation(async ({ where }) => Object.values(rows.ArtifactInputSnapshot ?? {})
    .filter(row => row.workspaceId === where.workspaceId && where.id.in.includes(row.id)));
  db.artifactInputLineage.findFirst.mockImplementation(async ({ where }) => manifests.filter(row => row.workspaceId === where.workspaceId
    && row.artifactType === where.artifactType && row.artifactId === where.artifactId
    && (where.contentHash === undefined || row.contentHash === where.contentHash)).sort((a, b) => b.revision - a.revision)[0] ?? null);
  db.artifactInputLineage.findMany.mockImplementation(async ({ where, orderBy, take }) => {
    const matched = manifests.filter(row => row.workspaceId === where.workspaceId
      && row.artifactType === where.artifactType
      && (typeof where.artifactId === "string" ? row.artifactId === where.artifactId : where.artifactId.in.includes(row.artifactId))
      && (where.id === undefined || row.id === where.id)
      && (where.contentHash === undefined || row.contentHash === where.contentHash)
      && (where.origin === undefined || row.origin === where.origin));
    if (orderBy?.revision === "desc") matched.sort((a, b) => b.revision - a.revision);
    return take === undefined ? matched : matched.slice(0, take);
  });
  db.artifactInputLineage.create.mockImplementation(async ({ data }) => {
    const row = { id: `manifest-${manifests.length}`, createdAt: date, ...data }; manifests.push(row); return row;
  });
  db.artifactInputSnapshot.create.mockImplementation(async ({ data }) => {
    rows.ArtifactInputSnapshot ??= {};
    const row = { id: `snapshot-${Object.keys(rows.ArtifactInputSnapshot).length}`, createdAt: date, ...data };
    rows.ArtifactInputSnapshot[row.id] = row; return row;
  });
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.$executeRaw.mockResolvedValue(1); db.$queryRaw.mockResolvedValue([]);
  installSourcePermissionEpochFixture(db);
});

describe("credential complete-source boundaries", () => {
  it.each(["credential-a", "credential-b"])("withholds private originals and both direct and snapshotted graph ancestry from %s", async id => {
    const actor = credential(id);
    const article = await add("BrainArticle", { id: "private-article", workspaceId: "ws-1", isPrivate: true, authority: "DRAFT", ownerMemberId: "owner-member", title: "Owner's private source", bodyMd: "Private original", createdAt: date });
    const action = await add("Action", { id: "private-action", workspaceId: "ws-1", isPrivate: true, status: "DRAFT", authorUserId: "owner", title: "Private draft", createdAt: date });
    const actionRoots = await captureArtifactInputProof(owner, "ws-1", [{ kind: "Action", id: action.id }], db as any);
    const graph = await add("ContextGraphObject", { id: "graph-direct", workspaceId: "ws-1", title: "Copied private fact", status: "active", createdAt: date }, actionRoots, "DERIVED");
    const snapshotRoots = await captureArtifactInputSnapshotProof(owner, "ws-1", { kind: "Action", id: action.id }, db as any);
    const historicalGraph = await add("ContextGraphObject", { ...graph, id: "graph-history" }, snapshotRoots, "DERIVED");
    expect(await readableArtifactIds(actor, "ws-1", "BrainArticle", [article])).toEqual(new Set());
    expect(await readableArtifactIds(actor, "ws-1", "ContextGraphObject", [graph, historicalGraph])).toEqual(new Set());
    await expect(captureArtifactInputProof(actor, "ws-1", [{ kind: "ContextGraphObject", id: graph.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await readableArtifactIds(owner, "ws-1", "ContextGraphObject", [graph, historicalGraph])).toEqual(new Set([graph.id, historicalGraph.id]));
  });

  it.each(["credential-a", "credential-b"])("denies %s personal and finance sources despite broad scopes", async id => {
    const actor = credential(id);
    const checkIn = await add("CheckIn", { id: "check-in", workspaceId: "ws-1", memberId: "owner-member", prompt: "Personal question", response: "Private answer", createdAt: date });
    const cost = { id: "cost", workspaceId: "ws-1", estimatedCostUsd: "0.10", billableCostUsd: null, createdAt: date };
    rows.ModelUsageCost = { [cost.id]: cost };
    const finance = { id: "finance-doc", workspaceId: "ws-1", accessDomain: "FINANCE", title: "Financial source", bodyMd: "Financial facts", createdAt: date };
    rows.Document = { [finance.id]: finance };
    for (const [kind, row] of [["CheckIn", checkIn], ["ModelUsageCost", cost], ["Document", finance]] as const) {
      expect(await readableArtifactIds(actor, "ws-1", kind, [row])).toEqual(new Set());
      await expect(captureArtifactInputProof(actor, "ws-1", [{ kind, id: row.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    }
  });

  it("keeps proven public workspace knowledge readable to both credentials", async () => {
    const article = await add("BrainArticle", { id: "public-article", workspaceId: "ws-1", isPrivate: false, authority: "REFERENCE", title: "Public fact", bodyMd: "Known original", createdAt: date });
    for (const id of ["credential-a", "credential-b"]) {
      expect(await readableArtifactIds(credential(id), "ws-1", "BrainArticle", [article])).toEqual(new Set([article.id]));
      await expect(captureArtifactInputProof(credential(id), "ws-1", [{ kind: "BrainArticle", id: article.id }])).resolves.toEqual([expect.objectContaining({ ...root("BrainArticle", article), permissionEpochs: expect.objectContaining({ version: 1, entries: expect.any(Array) }) })]);
    }
  });
});

describe("creation input admission with actual source checks", () => {
  it.each(["credential-a", "credential-b"])("requires current complete public inputs and never grants %s private ownership", async id => {
    const { requireCreationInputRoots } = await import("./draft-permissions");
    const actor = credential(id);
    const article = await add("BrainArticle", {id: "public-input", workspaceId: "ws-1", isPrivate: false, authority: "REFERENCE",
      title: "Known original", bodyMd: "Input", createdAt: date});
    const roots = await captureArtifactInputProof(actor, "ws-1", [{kind: "BrainArticle", id: article.id}]);
    await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: false})).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: true, roots})).rejects.toMatchObject({code: "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED"});
    await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: false, roots})).resolves.toEqual(roots);
    const {prepareProducerLineage} = await import("./producer-lineage");
    await expect(prepareProducerLineage({tx: db as any, actor, workspaceId: "ws-1", capture: {lineageRoots: roots}}))
      .resolves.toMatchObject({mode: "DERIVED", roots});
    article.isPrivate = true;
    await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: false, roots})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

  it("merges server-scoped incoming roots and rejects substituted principals or workspaces", async () => {
    const { requireCreationInputRoots } = await import("./draft-permissions");
    const { withMcpToolInputContext } = await import("./mcp-tool-input-context");
    const actor = credential("credential-a");
    const article = await add("BrainArticle", {id: "public-input", workspaceId: "ws-1", isPrivate: false, authority: "REFERENCE",
      title: "Known original", bodyMd: "Input", createdAt: date});
    const roots = await captureArtifactInputProof(actor, "ws-1", [{kind: "BrainArticle", id: article.id}]);
    await withMcpToolInputContext(actor, "ws-1", roots, async () => {
      await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: false})).resolves.toEqual(roots);
      await expect(requireCreationInputRoots({actor: credential("credential-b"), workspaceId: "ws-1", isPrivate: false}))
        .rejects.toMatchObject({code: "MCP_INPUT_SCOPE_MISMATCH"});
      await expect(requireCreationInputRoots({actor, workspaceId: "ws-other", isPrivate: false}))
        .rejects.toMatchObject({code: "MCP_INPUT_SCOPE_MISMATCH"});
      await expect(requireCreationInputRoots({actor, workspaceId: "ws-1", isPrivate: false,
        roots: [{...roots[0], fingerprint: "stale"}]})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    });
  });
});
