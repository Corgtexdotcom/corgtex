import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => {
  const state = { epoch: 0, phase: [] as string[], response: { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a" }, { id: "b" }] }) }] } as unknown,
    input: null as any, connection: { id: "connection", workspaceId: "ws", userId: "owner", providerKey: "notion",
      serverUrl: "https://mcp.notion.com/mcp", providerAccountId: null, status: "ACTIVE", accessTokenEnc: "encrypted-token", scopes: ["read"] } as any };
  const prisma: any = {
    member: { findFirst: vi.fn(async () => ({ id: "member", isActive: true })) },
    externalMcpConnection: { findFirst: vi.fn(async () => ({ ...state.connection })) },
    externalMcpResponseInput: { create: vi.fn(async ({ data }: any) => (state.input = { ...data, id: "response-1",
      fetchedAt: new Date("2026-10-13T00:00:00Z"), createdAt: new Date("2026-10-13T00:00:00Z") })),
    findFirst: vi.fn(async () => state.input && { ...state.input }) },
    artifactInputSnapshot: { findFirst: vi.fn(async () => null) },
    sourcePermissionEpoch: { findUnique: vi.fn(async () => ({ epoch: BigInt(state.epoch) })) },
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
  };
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => run({ ...prisma }));
  const remote = vi.fn(async () => { state.phase.push("remote"); return structuredClone(state.response); });
  return { state, prisma, remote };
});
vi.mock("@corgtex/shared", () => ({ prisma: f.prisma, encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, "") }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async () => ({ id: "member" })) }));
vi.mock("./external-mcp", () => {
  const native = (providerKey: string, mode: string, value: any) => {
    if (providerKey !== "notion") throw new Error("unsupported");
    const argumentsValue = mode === "SEARCH" ? { query: value.query, limit: value.limit } : { id: value.externalId };
    return { providerKey, mode, serverUrl: "https://mcp.notion.com/mcp",
      toolName: mode === "SEARCH" ? "notion-search" : "notion-fetch", arguments: argumentsValue };
  };
  return { externalMcpNativeReadRequest: native, externalMcpConnectionGrantHash: (c: any) => JSON.stringify([
    c.id, c.workspaceId, c.userId, c.providerKey, c.serverUrl, c.providerAccountId, c.scopes]),
    loadExternalMcpNativeConnection: vi.fn(async () => ({ ...f.state.connection })), readExternalMcpNativeToolResult: f.remote,
    assertExternalMcpNativeReadOrigin: vi.fn(async () => null) };
});
vi.mock("./source-permission-epochs", () => ({
  capturePermissionEpochs: vi.fn(async (_tx: unknown, _ws: string, identities: any[]) => {
    f.state.phase.push("epoch");
    return { version: 1, policyVersion: "pun68-permissions-v3",
      entries: [...identities].sort((a, b) => JSON.stringify([a.kind, a.id]).localeCompare(JSON.stringify([b.kind, b.id])))
        .map((entry) => ({ ...entry, epoch: String(f.state.epoch) })) };
  }),
  parsePermissionEpochProof: (value: any) => value?.version === 1 && Array.isArray(value.entries) ? value : null,
  isArtifactPermissionEpochProofCurrent: vi.fn(async (_ws: string, value: any) =>
    value?.entries?.every((entry: any) => entry.epoch === String(f.state.epoch)) === true),
}));
vi.mock("./source-lineage", () => ({ lineageContentFingerprint: (_kind: string, row: any) => JSON.stringify([
  row.id, row.workspaceId, row.connectionId, row.localUserId, row.providerKey, row.serverUrl, row.providerAccountId,
  row.mode, row.toolName, row.requestJson, row.encryptedResponseJson, row.responseHash, row.connectionGrantHash,
  row.originalLocalEpochsJson, row.fetchedAt]),
  inspectStoredArtifactInputDependencies: vi.fn(async (_db: unknown, _ws: string, roots: any[]) => ({ complete: true, roots })),
  assertArtifactInputClosureLocallyAdmissible: vi.fn(async () => undefined),
  isArtifactInputProofReadable: vi.fn(async () => true),
  sealArtifactInputActor: (actor: AppActor) => actor,
}));

import { captureExternalMcpResponseInput, externalMcpResponseHash, getExternalMcpResponseInputRoots,
  isExternalMcpResponseInputCurrent, prepareExternalMcpResponseCommitPreflight, registerExternalMcpResponseOutput,
  withExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
const owner = { kind: "user", user: { id: "owner", email: "owner@synthetic.test" } } as AppActor;
const other = { kind: "user", user: { id: "other", email: "other@synthetic.test" } } as AppActor;

describe("complete live external MCP native response receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.state.epoch = 0; f.state.phase = []; f.state.input = null;
    f.state.connection = { id: "connection", workspaceId: "ws", userId: "owner", providerKey: "notion",
      serverUrl: "https://mcp.notion.com/mcp", providerAccountId: null, status: "ACTIVE", accessTokenEnc: "encrypted-token", scopes: ["read"] };
    f.state.response = { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a" }, { id: "b" }] }) }] };
  });

  it("captures original local epochs before the full untruncated tool result and replays exact bytes", async () => {
    const receipt = await captureExternalMcpResponseInput(owner, { workspaceId: "ws", connectionId: "connection",
      mode: "SEARCH", query: "budget", limit: 1 });
    expect(f.state.phase).toEqual(["epoch", "remote"]);
    expect(JSON.parse(receipt.input.encryptedResponseJson.slice(4))).toEqual(f.state.response);
    expect(receipt.input.responseHash).toBe(externalMcpResponseHash(f.state.response));
    expect((receipt.input.originalLocalEpochsJson as any).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ExternalMcpConnectionSetPolicy", id: "owner", epoch: "0" }),
      expect.objectContaining({ kind: "ExternalMcpConnection", id: "connection", epoch: "0" }),
    ]));
    const { assertExternalMcpNativeReadOrigin } = await import("./external-mcp");
    expect(assertExternalMcpNativeReadOrigin).toHaveBeenCalledWith(owner, "ws", expect.objectContaining({
      externalMcpResponseInput: expect.anything(),
    }));
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(true);
    expect(f.remote).toHaveBeenCalledTimes(2);
  });

  it("records zero-hit result as a real response and denies changed bytes, grants, and revoked-restored epochs", async () => {
    f.state.response = { content: [{ type: "text", text: '{"results":[]}' }] };
    const receipt = await captureExternalMcpResponseInput(owner, { workspaceId: "ws", connectionId: "connection",
      mode: "SEARCH", query: "missing", limit: 5 });
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(true);
    f.state.response = { content: [{ type: "text", text: '{"results":[{"id":"late"}]}' }] };
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(false);
    f.state.response = receipt.payload;
    f.state.connection = { ...f.state.connection, scopes: ["other"] };
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(false);
    f.state.connection = { ...f.state.connection, scopes: ["read"] };
    f.state.epoch = 2; // Revoke then restore the same visible grant; the old epoch stays stale.
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(false);
  });

  it("denies a native row replacement during live replay even when remote bytes stay the same", async () => {
    const receipt = await captureExternalMcpResponseInput(owner, { workspaceId: "ws", connectionId: "connection",
      mode: "FETCH", externalId: "page" });
    f.remote.mockImplementationOnce(async () => {
      f.state.input = { ...f.state.input, responseHash: "0".repeat(64) };
      f.state.epoch += 1;
      return structuredClone(f.state.response);
    });
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input)).toBe(false);
  });

  it("rejects credentials, other users, and supplied transactions without an original live preflight", async () => {
    await expect(captureExternalMcpResponseInput({ kind: "agent" } as AppActor,
      { workspaceId: "ws", connectionId: "connection", mode: "SEARCH", query: "budget", limit: 1 })).rejects.toBeDefined();
    expect(f.remote).not.toHaveBeenCalled();
    const receipt = await captureExternalMcpResponseInput(owner, { workspaceId: "ws", connectionId: "connection",
      mode: "FETCH", externalId: "page" });
    expect(await isExternalMcpResponseInputCurrent(other, "ws", receipt.input)).toBe(false);
    expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input, { ...f.prisma } as any)).toBe(false);
    expect(f.remote).toHaveBeenCalledTimes(1);
  });

  it("keeps original proofs in a single-use transaction capability and binds registered DTO identity", async () => {
    const receipt = await captureExternalMcpResponseInput(owner, { workspaceId: "ws", connectionId: "connection",
      mode: "FETCH", externalId: "page" });
    const { lineageContentFingerprint } = await import("./source-lineage");
    const root: any = { kind: "ExternalMcpResponseInput", id: receipt.input.id,
      fingerprint: lineageContentFingerprint("ExternalMcpResponseInput", receipt.input),
      permissionEpochs: { version: 1, policyVersion: "pun68-permissions-v3",
        entries: [{ kind: "ExternalMcpResponseInput", id: receipt.input.id, epoch: "0" }] } };
    const result = registerExternalMcpResponseOutput(owner, "ws", { result: "synthetic" }, [root]);
    expect(await getExternalMcpResponseInputRoots(owner, "ws", result)).toEqual([root]);
    await expect(getExternalMcpResponseInputRoots(owner, "ws", { ...result })).rejects.toBeDefined();
    await expect(getExternalMcpResponseInputRoots(other, "ws", result)).rejects.toBeDefined();
    const token = await prepareExternalMcpResponseCommitPreflight(owner, "ws", [root]);
    const tx = { ...f.prisma } as any;
    await expect(withExternalMcpResponseCommitPreflight(owner, "ws", tx, token, async () => {
      expect(await isExternalMcpResponseInputCurrent(owner, "ws", receipt.input, tx)).toBe(true);
      return "done";
    })).resolves.toBe("done");
    await expect(withExternalMcpResponseCommitPreflight(owner, "ws", tx, token, async () => "again")).rejects.toBeDefined();
  });
});
