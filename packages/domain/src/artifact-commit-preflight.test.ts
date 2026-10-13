import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => {
  const prisma = { artifactInputSnapshot: { findFirst: vi.fn(async () => null) },
    artifactInputLineage: { findFirst: vi.fn(async () => null) } };
  const state = { closure: [] as any[], complete: true, epochCurrent: true, readable: true,
    savedProof: null as any, events: [] as string[] };
  return { prisma, state,
    inspect: vi.fn(async (_db: unknown, _ws: string, _roots: unknown[]) => ({ complete: state.complete, roots: state.closure })),
    read: vi.fn(async (_actor: unknown, _ws: string, _roots: unknown[], db: unknown) => {
      state.events.push(db === undefined || db === prisma ? "base-proof" : "tx-proof");
      return state.readable;
    }),
    boxPrepare: vi.fn(async () => Object.freeze({ backend: "box" })),
    mcpPrepare: vi.fn(async () => Object.freeze({ backend: "mcp" })),
    mixedPrepare: vi.fn(async () => Object.freeze({ backend: "mixed" })),
    boxWith: vi.fn(async (_actor: unknown, _ws: string, _tx: unknown, _token: unknown, work: () => Promise<unknown>) => work()),
    mcpWith: vi.fn(async (_actor: unknown, _ws: string, _tx: unknown, _token: unknown, work: () => Promise<unknown>) => work()),
    mixedWith: vi.fn(async (_actor: unknown, _ws: string, _tx: unknown, _roots: unknown[], _token: unknown,
      work: () => Promise<unknown>) => work()),
  };
});
vi.mock("@corgtex/shared", () => ({ prisma: f.prisma }));
vi.mock("./artifact-input-actor", () => ({ sealArtifactInputActor: vi.fn((actor: AppActor) => actor) }));
vi.mock("./source-lineage", () => ({ inspectStoredArtifactInputDependencies: f.inspect,
  isArtifactInputProofReadable: f.read }));
vi.mock("./source-permission-epochs", () => ({
  parsePermissionEpochProof: (value: any) => value?.version === 1 && Array.isArray(value.entries) ? value : null,
  isArtifactPermissionEpochProofCurrent: vi.fn(async () => f.state.epochCurrent),
}));
vi.mock("./external-provider-authority", () => ({ prepareExternalProviderRootCommitPreflight: f.boxPrepare,
  withExternalProviderCommitPreflight: f.boxWith }));
vi.mock("./external-mcp-response-input", () => ({ prepareExternalMcpResponseCommitPreflight: f.mcpPrepare,
  withExternalMcpResponseCommitPreflight: f.mcpWith }));
vi.mock("./external-mixed-commit", () => ({ prepareExternalMixedCommitPreflight: f.mixedPrepare,
  withExternalMixedCommitPreflight: f.mixedWith }));

import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";

const actor = { kind: "user", user: { id: "owner", email: "owner@synthetic.test" } } as AppActor;
const other = { kind: "user", user: { id: "other", email: "other@synthetic.test" } } as AppActor;
const workspaceId = "workspace";
const tx = { ...f.prisma } as any;
const root = (kind: string, id: string, withEpoch = false): any => ({ kind, id, fingerprint: `${kind}:${id}:v1`,
  ...(withEpoch ? { permissionEpochs: { version: 1, policyVersion: "pun68-permissions-v3",
    entries: [{ kind, id, epoch: "0" }] } } : {}) });

describe("artifact commit preflight dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.state.closure = []; f.state.complete = true; f.state.epochCurrent = true;
    f.state.readable = true; f.state.savedProof = null; f.state.events = [];
    f.prisma.artifactInputLineage.findFirst.mockImplementation(async () => f.state.savedProof);
  });

  it("selects the safe mixed wrapper from the full stored closure and checks all original roots around work", async () => {
    const original = [root("ContextGraphObject", "derived")];
    f.state.closure = [original[0], root("ExternalProviderFetchInput", "box"), root("ExternalMcpResponseInput", "mcp")];
    const capability = await prepareArtifactCommitPreflight(actor, workspaceId, original);
    expect(f.inspect).toHaveBeenCalledWith(f.prisma, workspaceId, original, { maxNodes: 10000 });
    expect(f.mixedPrepare).toHaveBeenCalledWith(actor, workspaceId, original);
    expect(f.boxPrepare).not.toHaveBeenCalled(); expect(f.mcpPrepare).not.toHaveBeenCalled();
    const work = vi.fn(async () => { f.state.events.push("write"); return "stored"; });
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, work)).resolves.toBe("stored");
    expect(f.mixedWith).toHaveBeenCalledWith(actor, workspaceId, tx, original,
      { backend: "mixed" }, expect.any(Function));
    expect(f.state.events).toEqual(["base-proof", "tx-proof", "write", "tx-proof"]);
  });

  it("checks an empty connection-set receipt locally without calling a provider backend", async () => {
    const original = [root("ArtifactInputSnapshot", "absence")];
    f.state.closure = [original[0], root("ExternalMcpConnectionSet", "owner")];
    const capability = await prepareArtifactCommitPreflight(actor, workspaceId, original);
    expect(f.mcpPrepare).not.toHaveBeenCalled();
    expect(f.boxPrepare).not.toHaveBeenCalled(); expect(f.mixedPrepare).not.toHaveBeenCalled();
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, async () => "empty"))
      .resolves.toBe("empty");
    expect(f.mcpWith).not.toHaveBeenCalled();
    expect(f.state.events).toEqual(["base-proof", "tx-proof", "tx-proof"]);
  });

  it("uses the Box preflight when a connection-set proof has no MCP response", async () => {
    const original = [root("ContextGraphObject", "derived"), root("ExternalMcpConnectionSet", "owner")];
    f.state.closure = [original[0], root("ExternalProviderFetchInput", "box"), original[1]];
    const capability = await prepareArtifactCommitPreflight(actor, workspaceId, original);
    expect(f.inspect).toHaveBeenCalledWith(f.prisma, workspaceId, original, { maxNodes: 10000 });
    expect(f.boxPrepare).toHaveBeenCalledWith(actor, workspaceId, original);
    expect(f.mcpPrepare).not.toHaveBeenCalled(); expect(f.mixedPrepare).not.toHaveBeenCalled();
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, async () => "box-only"))
      .resolves.toBe("box-only");
    expect(f.boxWith).toHaveBeenCalledTimes(1);
    expect(f.state.events).toEqual(["base-proof", "tx-proof", "tx-proof"]);
  });

  it("rejects an unsupported Slack-native closure before a selected Box preflight can replay", async () => {
    const original = [root("ContextGraphObject", "derived")];
    f.state.closure = [root("ExternalProviderFetchInput", "box"), root("CommunicationMessageNativeInput", "slack")];
    await expect(prepareArtifactCommitPreflight(actor, workspaceId, original))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(f.boxPrepare).not.toHaveBeenCalled(); expect(f.mcpPrepare).not.toHaveBeenCalled();
    expect(f.mixedPrepare).not.toHaveBeenCalled();
  });

  it("rejects a revoked stored contributor before any provider preflight can replay its query", async () => {
    const original = [root("ContextGraphObject", "derived")];
    f.state.closure = [root("ExternalProviderFetchInput", "box"), root("ExternalMcpResponseInput", "mcp")];
    f.state.savedProof = { epochProofVersion: 1,
      permissionEpochsJson: root("ExternalProviderFetchInput", "box", true).permissionEpochs };
    f.state.epochCurrent = false;
    await expect(prepareArtifactCommitPreflight(actor, workspaceId, original))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(isArtifactPermissionEpochProofCurrent).toHaveBeenCalled();
    expect(f.boxPrepare).not.toHaveBeenCalled(); expect(f.mcpPrepare).not.toHaveBeenCalled();
    expect(f.mixedPrepare).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it("binds the exact actor, workspace and root vector, then consumes a successful capability once", async () => {
    const original = [root("Workspace", "workspace")];
    f.state.closure = original;
    const capability = await prepareArtifactCommitPreflight(actor, workspaceId, original);
    const work = vi.fn(async () => "committed");
    await expect(withArtifactCommitPreflight(other, workspaceId, tx, original, capability, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(withArtifactCommitPreflight(actor, "other-workspace", tx, original, capability, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx,
      [root("Workspace", "changed")], capability, work)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(withArtifactCommitPreflight(actor, workspaceId, f.prisma as any, original, capability, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).not.toHaveBeenCalled();
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, work)).resolves.toBe("committed");
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a mixed backend callback when the current full proof is denied", async () => {
    const original = [root("ContextGraphObject", "derived")];
    f.state.closure = [root("ExternalProviderFetchInput", "box"), root("ExternalMcpResponseInput", "mcp")];
    const capability = await prepareArtifactCommitPreflight(actor, workspaceId, original);
    f.state.readable = false;
    const work = vi.fn(async () => "never");
    await expect(withArtifactCommitPreflight(actor, workspaceId, tx, original, capability, work))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.mixedWith).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });
});
