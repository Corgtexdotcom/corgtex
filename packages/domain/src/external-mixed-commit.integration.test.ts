import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, prisma, type AppActor } from "@corgtex/shared";

const remote = vi.hoisted(() => ({
  box: { text: "Synthetic selected Box bytes" } as unknown,
  mcp: { structuredContent: { results: [{ id: "synthetic-hit" }] } } as unknown,
  boxRead: vi.fn(), mcpRead: vi.fn(), inTransaction: 0,
}));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      const callback = args[0];
      return original(async (tx: any) => {
        remote.inTransaction++;
        try { return await callback(tx); } finally { remote.inTransaction--; }
      }, ...args.slice(1));
    };
  } });
  return { ...actual, prisma: instrumented };
});
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.boxRead,
  readExternalMcpNativeToolResult: remote.mcpRead,
}));

import { selectExternalContentSource } from "./external-content-sources";
import { captureExternalProviderFetchInput, isExternalProviderFetchInputCurrent,
  prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight } from "./external-provider-authority";
import { captureExternalMcpResponseInput, prepareExternalMcpResponseCommitPreflight,
  withExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { prepareExternalMixedCommitPreflight, withExternalMixedCommitPreflight } from "./external-mixed-commit";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "./source-lineage";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;
async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `mixed-owner-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `mixed-other-${suffix}@synthetic.test`, passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic mixed external commit", slug: `mixed-native-${suffix}` } });
  await prisma.member.createMany({ data: [user.id, other.id].map(userId => ({ workspaceId: workspace.id, userId, role: "ADMIN", isActive: true })) });
  const actor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } } as AppActor;
  const otherActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } } as AppActor;
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: user.id,
    providerKey: "box", displayName: "Synthetic selected Box", serverUrl: "https://mcp.box.com",
    providerAccountId: "synthetic-box-owner", accessTokenEnc: encryptSecret("synthetic-only-token"),
    scopes: ["root_readwrite"], status: "ACTIVE" } });
  const source = await selectExternalContentSource(actor, { workspaceId: workspace.id, providerKey: "box",
    sourceKind: "FILE", externalId: "synthetic-file", connectionId: connection.id, title: "Selected synthetic file" });
  const provider = await captureExternalProviderFetchInput(actor, { workspaceId: workspace.id,
    externalContentSourceId: source.id, connectionId: connection.id, sourceKind: "FILE", externalId: "synthetic-file",
    toolName: "get_file_content", arguments: { file_id: "synthetic-file" } });
  const mcp = await captureExternalMcpResponseInput(actor, { workspaceId: workspace.id,
    connectionId: connection.id, mode: "SEARCH", query: "synthetic", limit: 1 });
  const roots = await captureArtifactInputProof(actor, workspace.id, [
    { kind: "ExternalProviderFetchInput", id: provider.input.id },
    { kind: "ExternalMcpResponseInput", id: mcp.input.id, snapshot: mcp.input },
  ]);
  return { user, other, workspace, actor, otherActor, connection, source, provider, mcp, roots };
}

afterEach(async () => {
  const f = current; current = null;
  if (f) {
    await prisma.workspace.delete({ where: { id: f.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [f.user.id, f.other.id] } } });
  }
  remote.boxRead.mockClear(); remote.mcpRead.mockClear(); remote.inTransaction = 0;
  remote.box = { text: "Synthetic selected Box bytes" };
  remote.mcp = { structuredContent: { results: [{ id: "synthetic-hit" }] } };
});

describe("mixed selected Box and live MCP native commit scopes", () => {
  it("rejects standalone nesting, then writes a complete mixed output with no SDK call in the transaction", async () => {
    const f = current = await fixture();
    const provider = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, f.roots);
    const mcp = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    await expect(prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id, tx, provider,
      () => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, tx, mcp, async () => "unreachable"))))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();

    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    const row = await prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id, tx, f.roots, token,
      async () => {
        expect(await isExternalProviderFetchInputCurrent(f.actor, f.workspace.id, f.provider.input, tx)).toBe(true);
        const output = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "EXTERNAL_CONTENT", tier: 2,
          title: "Mixed synthetic source", content: "Combined response", channel: "box" } });
        await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "BrainSource", id: output.id }, content: output,
          origin: "DERIVED", inputs: [], inheritedRoots: f.roots });
        return output;
      }));
    expect(remote.boxRead).not.toHaveBeenCalled();
    expect(remote.mcpRead).not.toHaveBeenCalled();
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id,
      await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: row.id }]))).toBe(true);
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id, tx,
      f.roots, token, async () => "reused"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("binds actor, workspace and complete roots before consuming its single-use capability", async () => {
    const f = current = await fixture();
    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.otherActor, f.workspace.id,
      tx, f.roots, token, async () => "wrong actor"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, randomUUID(),
      tx, f.roots, token, async () => "wrong workspace"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots.slice(0, 1), token, async () => "incomplete roots"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.boxRead).not.toHaveBeenCalled(); expect(remote.mcpRead).not.toHaveBeenCalled();
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots, token, async () => "valid"))).resolves.toBe("valid");
  });

  it("rejects a revoked and restored grant without native replay or work", async () => {
    const f = current = await fixture();
    const provider = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, f.roots);
    const mcp = await prepareExternalMcpResponseCommitPreflight(f.actor, f.workspace.id, f.roots);
    const token = await prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots);
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { status: "ACTIVE" } });
    remote.boxRead.mockClear(); remote.mcpRead.mockClear();
    const work = vi.fn(async () => "wrong");
    await expect(prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id,
      tx, provider, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMcpResponseCommitPreflight(f.actor, f.workspace.id,
      tx, mcp, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prisma.$transaction(tx => withExternalMixedCommitPreflight(f.actor, f.workspace.id,
      tx, f.roots, token, work))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled();
    expect(remote.boxRead).not.toHaveBeenCalled(); expect(remote.mcpRead).not.toHaveBeenCalled();
  });

  it("rejects either stale remote response before opening a writer transaction", async () => {
    const f = current = await fixture();
    remote.box = { text: "Changed selected Box bytes" };
    await expect(prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    remote.box = { text: "Synthetic selected Box bytes" };
    remote.mcp = { structuredContent: { results: [{ id: "changed-hit" }] } };
    await expect(prepareExternalMixedCommitPreflight(f.actor, f.workspace.id, f.roots))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(remote.inTransaction).toBe(0);
  });
});

remote.boxRead.mockImplementation(async () => {
  if (remote.inTransaction) throw new Error("Box SDK called during a writer transaction.");
  return structuredClone(remote.box);
});
remote.mcpRead.mockImplementation(async () => {
  if (remote.inTransaction) throw new Error("MCP SDK called during a writer transaction.");
  return structuredClone(remote.mcp);
});
