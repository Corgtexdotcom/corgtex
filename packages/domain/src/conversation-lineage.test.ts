import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { SOURCE_PERMISSION_POLICY_VERSION, type PermissionEpochProof } from "./source-permission-epochs";
import type { Prisma } from "@prisma/client";
import { AppError } from "./errors";

const lineage = vi.hoisted(() => ({ captureArtifactInputProof: vi.fn(), isArtifactInputProofReadable: vi.fn() }));
vi.mock("./source-lineage", () => lineage);
import {
  captureConversationInputReceipt,
  collectConversationInputReceipts,
  validateConversationInputReceipt,
  type ConversationInputReceipt,
} from "./conversation-lineage";

const actor = { kind: "user", user: { id: "synthetic-user-a", email: "a@example.test", displayName: null } } as AppActor;
const other = { kind: "user", user: { id: "synthetic-user-b", email: "b@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-workspace-a";
const root = { kind: "BrainSource" as const, id: "synthetic-source-a", fingerprint: "a".repeat(64) };
const otherRoot = { kind: "BrainSource" as const, id: "synthetic-source-b", fingerprint: "b".repeat(64) };
const value = { text: "Synthetic permitted context", count: 1 };
const base = { actor, workspaceId, value };

async function fragment(supplied: unknown = value, roots = [root]) {
  return { value: supplied, receipt: await captureConversationInputReceipt({ ...base, value: supplied, trustedRoots: roots }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  lineage.captureArtifactInputProof.mockResolvedValue([root]);
  lineage.isArtifactInputProofReadable.mockResolvedValue(true);
});

describe("conversation input receipts", () => {
  it("refuses conflicting permission revisions even when source content is identical", async () => {
    const proof: PermissionEpochProof = { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: root.kind, id: root.id, epoch: "2" }] };
    const first = await captureConversationInputReceipt({ ...base, trustedRoots: [{ ...root, permissionEpochs: proof }] });
    const second = await captureConversationInputReceipt({ ...base, trustedRoots: [{ ...root,
      permissionEpochs: { ...proof, entries: [{ kind: root.kind, id: root.id, epoch: "4" }] } }] });
    await expect(collectConversationInputReceipts({ ...base, fragments: [{ value, receipt: first }, { value, receipt: second }] }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("prevents returned permission vectors from mutating the stored receipt", async () => {
    const permissionEpochs: PermissionEpochProof = { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: root.kind, id: root.id, epoch: "2" }] };
    const receipt = await captureConversationInputReceipt({ ...base, trustedRoots: [{ ...root, permissionEpochs }] });
    const returned = await validateConversationInputReceipt({ ...base, receipt });
    returned[0]!.permissionEpochs!.entries[0]!.epoch = "99";
    expect((await validateConversationInputReceipt({ ...base, receipt }))[0]!.permissionEpochs!.entries[0]!.epoch).toBe("2");
  });
  it("captures all supplied dependencies before use, with exact scalar snapshots", async () => {
    const inputs = [{ kind: "BrainSource" as const, id: root.id, snapshot: { title: "Synthetic title", contentText: value.text } }];
    const receipt = await captureConversationInputReceipt({ ...base, inputs, trustedRoots: [otherRoot] });
    expect(lineage.captureArtifactInputProof).toHaveBeenCalledWith(actor, workspaceId, inputs, undefined);
    expect(await validateConversationInputReceipt({ ...base, receipt })).toEqual([root, otherRoot]);
  });

  it("rejects arbitrary JSON or deserialized receipt lookalikes", async () => {
    const captured = await fragment();
    const replay = JSON.parse(JSON.stringify(captured.receipt)) as ConversationInputReceipt;
    await expect(validateConversationInputReceipt({ ...base, receipt: replay })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(validateConversationInputReceipt({ ...base, receipt: { type: "conversation-input-receipt", payloadHash: captured.receipt.payloadHash } }))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
  });

  it("rejects cross-user and cross-workspace replays even when those readers can read the source", async () => {
    const { receipt } = await fragment();
    await expect(validateConversationInputReceipt({ ...base, actor: other, receipt })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(validateConversationInputReceipt({ ...base, workspaceId: "synthetic-workspace-b", receipt })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
  });

  it("rejects an agent credential version or support-origin change", async () => {
    const agent = { kind: "agent", authProvider: "credential", label: "synthetic", credentialId: "credential-a", credentialVersion: "v1",
      workspaceIds: [workspaceId], supportOrigin: { userId: "support-a", workspaceId, version: 1 } } as Extract<AppActor, { kind: "agent" }>;
    const receipt = await captureConversationInputReceipt({ ...base, actor: agent, trustedRoots: [root] });
    await expect(validateConversationInputReceipt({ ...base, actor: { ...agent, credentialVersion: "v2" }, receipt }))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(validateConversationInputReceipt({ ...base, actor: { ...agent, supportOrigin: { userId: "support-a", workspaceId, version: 2 } }, receipt }))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
  });

  it("binds text and counts to the receipt while allowing equivalent object key order", async () => {
    const { receipt } = await fragment();
    expect(await validateConversationInputReceipt({ ...base, value: { count: 1, text: value.text }, receipt })).toEqual([root]);
    await expect(validateConversationInputReceipt({ ...base, value: { ...value, text: "Different unproven text" }, receipt })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(validateConversationInputReceipt({ ...base, value: { ...value, count: 9 }, receipt })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("refuses a no-source claim and conflicting revisions", async () => {
    await expect(captureConversationInputReceipt(base)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(captureConversationInputReceipt({ ...base, inputs: [{ kind: root.kind, id: root.id }],
      trustedRoots: [{ ...root, fingerprint: "c".repeat(64) }] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("blocks source revocation, deletion and current membership failure at release", async () => {
    const { receipt } = await fragment();
    lineage.isArtifactInputProofReadable.mockResolvedValue(false);
    await expect(validateConversationInputReceipt({ ...base, receipt })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    lineage.isArtifactInputProofReadable.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "Synthetic departed member"));
    await expect(validateConversationInputReceipt({ ...base, receipt })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("checks source permissions at capture and does not issue a stale receipt", async () => {
    lineage.isArtifactInputProofReadable.mockResolvedValue(false);
    await expect(captureConversationInputReceipt({ ...base, trustedRoots: [root] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("detects payload mutation while asynchronous capture or validation runs", async () => {
    const mutable = { text: value.text };
    lineage.isArtifactInputProofReadable.mockImplementationOnce(async () => { mutable.text = "Changed during capture"; return true; });
    await expect(captureConversationInputReceipt({ ...base, value: mutable, trustedRoots: [root] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const captured = await fragment(mutable);
    lineage.isArtifactInputProofReadable.mockImplementationOnce(async () => { mutable.text = "Changed during validation"; return true; });
    await expect(validateConversationInputReceipt({ ...base, ...captured })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("unions cited and uncited context and detects conflicts across fragments", async () => {
    const cited = await fragment("Cited synthetic context");
    const uncited = await fragment("Uncited synthetic context", [otherRoot]);
    expect(await collectConversationInputReceipts({ actor, workspaceId, fragments: [cited, uncited] })).toEqual([root, otherRoot]);
    const changed = await fragment("Later changed context", [{ ...root, fingerprint: "c".repeat(64) }]);
    await expect(collectConversationInputReceipts({ actor, workspaceId, fragments: [cited, changed] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rechecks the whole proof after checking later fragments", async () => {
    const first = await fragment();
    const later = await fragment("Later synthetic context", [otherRoot]);
    lineage.isArtifactInputProofReadable.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(collectConversationInputReceipts({ actor, workspaceId, fragments: [first, later] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("detects an earlier fragment mutation while checking the complete proof", async () => {
    const mutable = { text: "Original synthetic context" };
    const first = await fragment(mutable);
    const later = await fragment("Later synthetic context", [otherRoot]);
    lineage.isArtifactInputProofReadable.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => { mutable.text = "Mutated before release"; return true; });
    await expect(collectConversationInputReceipts({ actor, workspaceId, fragments: [first, later] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("does not omit context admitted concurrently during the final grant check", async () => {
    const first = await fragment();
    const later = await fragment("Later synthetic context", [otherRoot]);
    const fragments = [first];
    lineage.isArtifactInputProofReadable.mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => { fragments.push(later); return true; });
    await expect(collectConversationInputReceipts({ actor, workspaceId, fragments })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("validates persistence against the caller's write transaction and never exposes mutable internal roots", async () => {
    const captured = await fragment();
    const tx = {} as Prisma.TransactionClient;
    const roots = await collectConversationInputReceipts({ actor, workspaceId, fragments: [captured], db: tx });
    expect(lineage.isArtifactInputProofReadable).toHaveBeenLastCalledWith(actor, workspaceId, [root], tx);
    roots[0]!.fingerprint = "mutated caller result";
    expect(await validateConversationInputReceipt({ ...base, receipt: captured.receipt })).toEqual([root]);
  });

  it("rejects nonserializable context and an empty fragment set", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(captureConversationInputReceipt({ ...base, value: cycle, trustedRoots: [root] })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(captureConversationInputReceipt({ ...base, value: undefined, trustedRoots: [root] })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(collectConversationInputReceipts({ actor, workspaceId, fragments: [] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
});
