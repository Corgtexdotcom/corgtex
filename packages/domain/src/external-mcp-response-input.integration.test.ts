import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, prisma, type AppActor } from "@corgtex/shared";

const remote = vi.hoisted(() => ({ payload: { structuredContent: { results: [{ id: "first" }, { id: "second" }] } } as unknown,
  read: vi.fn(async () => structuredClone(remote.payload)) }));
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readExternalMcpNativeToolResult: remote.read }));

import { captureExternalMcpResponseInput, getExternalMcpResponseInputRoots, isExternalMcpResponseInputCurrent,
  prepareExternalMcpResponseCommitPreflight, registerExternalMcpResponseOutput, withExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "./source-lineage";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;
async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `external-native-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `external-other-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic external response", slug: `external-native-${suffix}` } });
  await prisma.member.createMany({ data: [user.id, other.id].map(userId => ({ workspaceId: workspace.id, userId, role: "ADMIN", isActive: true })) });
  const actor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } } as AppActor;
  const otherActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } } as AppActor;
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: user.id,
    providerKey: "notion", displayName: "Synthetic Notion", serverUrl: "https://mcp.notion.com/mcp",
    accessTokenEnc: encryptSecret("synthetic-token"), scopes: ["read"], status: "ACTIVE" } });
  return { user, other, workspace, actor, otherActor, connection };
}
afterEach(async () => {
  const f = current; current = null;
  if (f) {
    await prisma.workspace.delete({ where: { id: f.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [f.user.id, f.other.id] } } });
  }
  remote.read.mockClear();
  remote.payload = { structuredContent: { results: [{ id: "first" }, { id: "second" }] } };
});

describe("external MCP response native authority with real source helpers and PostgreSQL epochs", () => {
  it("publishes an empty connection-set proof locally and rejects an insertion before work", async () => {
    const f = current = await fixture();
    const roots = await captureArtifactInputProof(f.otherActor, f.workspace.id,
      [{ kind: "ExternalMcpConnectionSet", id: f.other.id }]);
    const first = await prepareArtifactCommitPreflight(f.otherActor, f.workspace.id, roots);
    const second = await prepareArtifactCommitPreflight(f.otherActor, f.workspace.id, roots);
    const work = vi.fn(async () => "permitted empty result");
    remote.read.mockClear();
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.otherActor, f.workspace.id, tx, roots, first, work))).resolves.toBe("permitted empty result");
    expect(work).toHaveBeenCalledOnce();
    expect(remote.read).not.toHaveBeenCalled();
    await prisma.externalMcpConnection.create({ data: { workspaceId: f.workspace.id, userId: f.other.id,
      providerKey: "notion", displayName: "Synthetic later connection", serverUrl: "https://mcp.notion.com/mcp",
      accessTokenEnc: encryptSecret("synthetic-token"), scopes: ["read"], status: "ACTIVE" } });
    work.mockClear();
    await expect(prisma.$transaction(tx => withArtifactCommitPreflight(f.otherActor, f.workspace.id, tx, roots, second, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled();
    expect(remote.read).not.toHaveBeenCalled();
  });

  it("keeps the full pre-limit response, complete read roots, owner fencing, and exact live bytes", async () => {
    const f = current = await fixture();
    const receipt = await captureExternalMcpResponseInput(f.actor, { workspaceId: f.workspace.id,
      connectionId: f.connection.id, mode: "SEARCH", query: "synthetic", limit: 1 });
    expect(Object.isFrozen(f.actor)).toBe(true);
    expect(Object.isFrozen(f.actor.kind === "user" ? f.actor.user : null)).toBe(true);
    expect(JSON.parse((await import("@corgtex/shared")).decryptSecret(receipt.input.encryptedResponseJson))).toEqual(remote.payload);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id,
      [{ kind: "ExternalMcpResponseInput", id: receipt.input.id, snapshot: receipt.input }]);
    expect(roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ExternalMcpResponseInput", id: receipt.input.id })]));
    const output = registerExternalMcpResponseOutput(f.actor, f.workspace.id, { results: [{ id: "first" }] }, roots);
    expect(await getExternalMcpResponseInputRoots(f.actor, f.workspace.id, output)).toEqual(roots);
    await expect(getExternalMcpResponseInputRoots(f.actor, f.workspace.id, { ...output })).rejects.toBeDefined();
    expect(await isExternalMcpResponseInputCurrent(f.otherActor, f.workspace.id, receipt.input)).toBe(false);
    remote.payload = { structuredContent: { results: [{ id: "first" }, { id: "changed" }] } };
    expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, receipt.input)).toBe(false);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
  });

  it("denies revoke then restore of the same connection without reminting the old original vector", async () => {
    const f = current = await fixture();
    const receipt = await captureExternalMcpResponseInput(f.actor, { workspaceId: f.workspace.id,
      connectionId: f.connection.id, mode: "SEARCH", query: "none", limit: 5 });
    expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, receipt.input)).toBe(true);
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
    remote.read.mockClear();
    expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, receipt.input)).toBe(false);
    expect(remote.read).not.toHaveBeenCalled();
  });

  it("invalidates an empty connection-set proof on later insert and fences supplied transactions without replay", async () => {
    const f = current = await fixture();
    const emptyOwner = f.otherActor;
    const absence = await captureArtifactInputProof(emptyOwner, f.workspace.id,
      [{ kind: "ExternalMcpConnectionSet", id: f.other.id }]);
    expect(await isArtifactInputProofReadable(emptyOwner, f.workspace.id, absence)).toBe(true);
    await prisma.externalMcpConnection.create({ data: { workspaceId: f.workspace.id, userId: f.other.id,
      providerKey: "notion", displayName: "Second synthetic Notion", serverUrl: "https://mcp.notion.com/mcp",
      accessTokenEnc: encryptSecret("second-synthetic-token"), scopes: ["read"], status: "ACTIVE" } });
    expect(await isArtifactInputProofReadable(emptyOwner, f.workspace.id, absence)).toBe(false);

    const receipt = await captureExternalMcpResponseInput(f.actor, { workspaceId: f.workspace.id,
      connectionId: f.connection.id, mode: "FETCH", externalId: "synthetic-page" });
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id,
      [{ kind: "ExternalMcpResponseInput", id: receipt.input.id, snapshot: receipt.input }]);
    await prisma.$transaction(async tx => {
      expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, receipt.input, tx)).toBe(false);
    });
    const preflight = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, roots);
    remote.read.mockClear();
    await expect(prisma.$transaction(tx => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, tx, preflight,
      async () => {
        expect(await isExternalMcpResponseInputCurrent(f.actor, f.workspace.id, receipt.input, tx)).toBe(true);
        return "committed";
      }))).resolves.toBe("committed");
    expect(remote.read).not.toHaveBeenCalled();
    await expect(prisma.$transaction(tx => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, tx, preflight,
      async () => "reused"))).rejects.toBeDefined();
  });
});
