import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "../../../domain/src/errors";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), upsert: vi.fn(), archive: vi.fn(), credentialAccess: vi.fn(), reveal: vi.fn(), roots: vi.fn(), readable: vi.fn(), outcomeRoots: vi.fn(), priorOutcome: vi.fn(),
}));
vi.mock("../../../domain/src/source-lineage", () => ({
  captureArtifactInputProof: vi.fn(),
  isArtifactInputProofReadable: mocks.readable,
  rebaseArtifactInputProofToSnapshots: vi.fn(),
}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../domain/src/conversation-lineage"),
  AppError,
  archiveWorkspaceToolLink: mocks.archive,
  listWorkspaceToolLinks: mocks.list,
  getWorkspaceToolLinkCredentialAccess: mocks.credentialAccess,
  getWorkspaceToolLinkInputRoots: mocks.roots,
  getConversationOperationOutcomeInputRoots: mocks.outcomeRoots,
  readConversationToolLinkArchiveOutcome: mocks.priorOutcome,
  revealWorkspaceToolLinkCredential: mocks.reveal,
  upsertWorkspaceToolLink: mocks.upsert,
  isArtifactInputProofReadable: mocks.readable,
}));
import { validateConversationInputReceipt } from "../../../domain/src/conversation-lineage";
import {
  archiveToolLinkAction, getToolLinkActionInputReceipt, getToolLinkArchiveEffectReceipt,
  listToolLinksAction, revealToolLinkCredentialAction, upsertToolLinkAction,
} from "./tool-links";

const actor: AppActor = { kind: "user", user: { id: "user-1", email: "fixture@example.com", displayName: "Fixture", globalRole: "USER" } };
const request = { kind: "ConversationPromptInput" as const, id: "request-1", fingerprint: "a".repeat(64) };
const target = { kind: "WorkspaceToolLink" as const, id: "tool-1", fingerprint: "b".repeat(64) };
const credential = { kind: "WorkspaceToolLinkCredential" as const, id: "tool-1", fingerprint: "c".repeat(64) };
const ctx = { workspaceId: "ws", lineageRoots: [request, target], requestLineageRoots: [request] };

async function validate(value: object, testActor = actor) {
  const receipt = getToolLinkActionInputReceipt(value)!;
  return validateConversationInputReceipt({ actor: testActor, workspaceId: "ws", value, receipt });
}

describe("ToolLink native chat receipts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readable.mockResolvedValue(true);
    mocks.list.mockResolvedValue([{ id: "tool-1", title: "Fixture link", hasCredential: true }]);
    mocks.upsert.mockResolvedValue({ id: "tool-1", title: "Fixture link", hasCredential: true });
    mocks.archive.mockResolvedValue({ success: true, message: "The tool link was archived." });
    mocks.priorOutcome.mockResolvedValue(null);
    mocks.outcomeRoots.mockResolvedValue([request, { kind: "ConversationOperationOutcome", id: "outcome-1", fingerprint: "d".repeat(64) }]);
    mocks.credentialAccess.mockResolvedValue({ credentialLabel: "Fixture label", hasCredential: true });
    mocks.roots.mockResolvedValue([target]);
  });

  it("binds native list output to the exact result, actor and complete domain roots", async () => {
    const value = await listToolLinksAction(actor, ctx);
    expect(value).toEqual({ items: [{ id: "tool-1", title: "Fixture link", hasCredential: true }] });
    await expect(validate(value)).resolves.toEqual([target]);
    expect(getToolLinkActionInputReceipt({ ...value })).toBeUndefined();
    await expect(validate(value, { ...actor, user: { ...actor.user, id: "user-2" } })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    value.items[0]!.title = "tampered";
    await expect(validate(value)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects a native list whose source grant changed before receipt release", async () => {
    mocks.readable.mockResolvedValue(false);
    await expect(listToolLinksAction(actor, ctx)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("preserves full model roots on upsert and binds only safe response metadata", async () => {
    const value = await upsertToolLinkAction(actor, ctx, { title: "Fixture link", url: "https://example.com", credentialSecret: "synthetic-only" });
    expect(mocks.upsert).toHaveBeenCalledWith(actor, expect.objectContaining({ lineageRoots: ctx.lineageRoots, credentialSecret: "synthetic-only" }));
    expect(value).toEqual({ success: true, toolLinkId: "tool-1", title: "Fixture link", hasCredential: true });
    expect(JSON.stringify(value)).not.toContain("synthetic-only");
    await expect(validate(value)).resolves.toEqual([target]);
  });

  it("refuses model upsert without incoming full proof even with a human actor", async () => {
    await expect(upsertToolLinkAction(actor, { workspaceId: "ws" }, { title: "Unproved", url: "https://example.com" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses upsert with revoked model drivers before the write", async () => {
    mocks.readable.mockResolvedValue(false);
    await expect(upsertToolLinkAction(actor, ctx, { title: "Unproved", url: "https://example.com" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("restores credential requests as protected UI handoff with exact private blob proof", async () => {
    mocks.roots.mockResolvedValue([target, credential]);
    const value = await revealToolLinkCredentialAction(actor, ctx, { toolLinkId: "tool-1" });
    expect(value).toMatchObject({ requiresSecureReveal: true, toolLinkId: "tool-1", credentialLabel: "Fixture label", hasCredential: true, webUrl: "/workspaces/ws/tools" });
    expect(value).not.toHaveProperty("credentialSecret");
    expect(mocks.reveal).not.toHaveBeenCalled();
    await expect(validate(value)).resolves.toEqual([target, credential]);
    mocks.readable.mockResolvedValue(false);
    await expect(validate(value)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("does not return a credential handoff when the current source proof is unknown", async () => {
    mocks.credentialAccess.mockRejectedValue(new AppError(409, "UNKNOWN_LINEAGE", "Unknown credential."));
    await expect(revealToolLinkCredentialAction(actor, ctx, { toolLinkId: "tool-1" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("keeps archive acknowledgment independent while the old body proof is revoked", async () => {
    let archived = false;
    mocks.readable.mockImplementation(async (_actor, _ws, roots) => !archived || roots.every((root: { id: string }) => root.id !== "tool-1"));
    mocks.archive.mockImplementation(async () => { archived = true; return { success: true, message: "The tool link was archived." }; });
    const value = await archiveToolLinkAction(actor, ctx, { toolLinkId: "tool-1", reason: "Fixture removal" });
    expect(value).toEqual({ success: true, message: "The tool link was archived." });
    expect(JSON.stringify(value)).not.toContain("tool-1");
    expect(mocks.archive).toHaveBeenCalledWith(actor, expect.objectContaining({ lineageRoots: [request, target] }));
    await expect(validate(value)).resolves.toEqual(expect.arrayContaining([request, expect.objectContaining({ kind: "ConversationOperationOutcome" })]));
    await expect(getToolLinkArchiveEffectReceipt(actor, "ws", value)).resolves.toBe(getToolLinkActionInputReceipt(value));
    expect(await mocks.readable(actor, "ws", [target])).toBe(false);
    await expect(getToolLinkArchiveEffectReceipt(actor, "ws", { ...value })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("requires separate request proof before archive, keeping unproved whole context untouched", async () => {
    await expect(archiveToolLinkAction(actor, { workspaceId: "ws", lineageRoots: [request, target] }, { toolLinkId: "tool-1" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("withholds terminal acknowledgment if its original request is revoked during the effect", async () => {
    mocks.archive.mockImplementation(async () => { mocks.readable.mockResolvedValue(false); return { success: true, message: "The tool link was archived." }; });
    await expect(archiveToolLinkAction(actor, ctx, { toolLinkId: "tool-1" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(mocks.archive).toHaveBeenCalledOnce();
  });
  it("replays an exact committed native outcome without re-consuming revoked model context", async () => {
    const prior = { success: true, message: "The tool link was archived." };
    mocks.priorOutcome.mockResolvedValue(prior);
    mocks.readable.mockImplementation(async (_actor, _ws, roots) => roots.every((root: { id: string }) => root.id !== "tool-1"));
    const value = await archiveToolLinkAction(actor, ctx, { toolLinkId: "tool-1" });
    expect(value).toBe(prior);
    expect(mocks.archive).not.toHaveBeenCalled();
    await expect(getToolLinkArchiveEffectReceipt(actor, "ws", value)).resolves.toBe(getToolLinkActionInputReceipt(value));
  });

});
