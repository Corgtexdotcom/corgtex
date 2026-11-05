import { beforeEach, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@corgtex/shared", () => ({ prisma: { auditLog: { create } } }));
import { ConversationInterruptionJournal } from "./conversation-interruption";

const actor = { kind: "user" as const, user: { id: "synthetic-user", email: "test@example.test", displayName: null } };
const input = { workspaceId: "synthetic-workspace", promptInputId: "synthetic-prompt" };
beforeEach(() => { create.mockReset().mockResolvedValue({ id: "synthetic-audit" }); });

it("records an entered handler conservatively without waiting for its outcome", async () => {
  const journal = new ConversationInterruptionJournal();
  let release!: () => void;
  const held = journal.observe("create_action", () => new Promise<void>(resolve => { release = resolve; }));
  await journal.persist(input, actor);
  expect(create.mock.calls[0][0].data.meta.calls).toEqual([
    { toolName: "create_action", handlerState: "entered", effectState: "unknown" },
  ]);
  release();
  await held;
  // A previously submitted receipt must not mutate with later in-process state.
  expect(create.mock.calls[0][0].data.meta.calls[0].handlerState).toBe("entered");
});

it("keeps returned values and rejected errors out of persisted metadata", async () => {
  const journal = new ConversationInterruptionJournal();
  const privateResult = { secret: "synthetic private tool output" };
  expect(await journal.observe("create_action", async () => privateResult)).toBe(privateResult);
  const privateFailure = new Error("synthetic private rejection");
  await expect(journal.observe("update_action", async () => { throw privateFailure; })).rejects.toBe(privateFailure);
  await journal.persist(input, actor);
  expect(create.mock.calls[0][0].data.meta.calls).toEqual([
    { toolName: "create_action", handlerState: "returned", effectState: "unknown" },
    { toolName: "update_action", handlerState: "rejected", effectState: "unknown" },
  ]);
  expect(JSON.stringify(create.mock.calls)).not.toContain("private");
});

it("does not retry an uncertain write or expose its error", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // Simulate commit followed by lost acknowledgement; a retry could duplicate it.
    create.mockRejectedValueOnce(new Error("synthetic private database detail"));
    await expect(new ConversationInterruptionJournal().persist(input, actor)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith("Conversation interruption audit persistence could not be confirmed.");
  } finally { warn.mockRestore(); }
});

it("binds an MCP observation to its admitted ingress without inventing a user identity", async () => {
  await new ConversationInterruptionJournal().persist({ workspaceId: "synthetic-workspace", ingressInputId: "synthetic-ingress" },
    { kind: "agent", authProvider: "credential", label: "synthetic-agent", credentialId: "synthetic-credential" });
  expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
    actorUserId: null, entityType: "ConversationIngressInput", entityId: "synthetic-ingress",
  }) });
});

it("does not attach observations to a fabricated fallback when no admitted input exists", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await new ConversationInterruptionJournal().persist({ workspaceId: input.workspaceId }, actor);
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  } finally { warn.mockRestore(); }
});
