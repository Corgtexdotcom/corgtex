import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PublicationPort } from "../contracts";
import { acceptanceFixture, barrier, input, success, toolCall } from "./fixture";

vi.mock("../../../../models/src/usage", () => ({
  assertWorkspaceModelBudget: vi.fn().mockResolvedValue(undefined),
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  recordModelUsage: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function publication() {
  let approved = false;
  const port: PublicationPort = {
    prepare: vi.fn(async () => ({ id: "approval-canary", selectionDigest: "synthetic-exact-selection" })),
    decision: vi.fn(async () => approved ? "APPROVED" : "PENDING"),
    inspect: vi.fn<PublicationPort["inspect"]>(async () => ({ status: "NOT_COMMITTED" })),
    commit: vi.fn<PublicationPort["commit"]>(async () => ({ status: "COMMITTED", receiptId: "synthetic-receipt" })),
  };
  return { port, approve: () => { approved = true; } };
}

// These exercise composed gateway/graph behavior with synthetic app ports and MemorySaver.
// They are NOT proof of real PostgreSQL durability, atomic approval/effect writes or SQL fencing.
describe("composed synthetic replay and publication acceptance", () => {
  it("rejects extra publication fields and publishes only selected content while replay stays inert", async () => {
    const p = publication();
    const privateConversation = "PRIVATE-CONVERSATION-CANARY-83";
    const privateEvidence = "PRIVATE-EVIDENCE-CANARY-27";
    const selection = { result: "Share this selected conclusion", approvedContextSummary: "Share this brief context" };
    const read = {
      name: "read_brain" as const,
      description: "Read synthetic evidence",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      arguments: z.object({}).strict(),
      execute: vi.fn(async () => ({ content: privateEvidence, sources: [{ kind: "brain" as const, id: "private-source-canary" }] })),
    };
    const f = await acceptanceFixture({ capabilities: { reads: [read], publication: p.port } });
    f.fetchMock
      .mockResolvedValueOnce(success("", [toolCall("read_brain")]))
      .mockResolvedValueOnce(success("", [toolCall("publish_selection", { ...selection, messages: [privateConversation], evidence: privateEvidence }, "invalid-publication")]))
      .mockResolvedValueOnce(success("", [toolCall("publish_selection", selection, "valid-publication")]))
      .mockResolvedValueOnce(success("Selected conclusion saved"));

    await expect(f.runner().run({ messages: [{ role: "user", content: privateConversation }] }))
      .resolves.toEqual({ status: "waiting", approvalId: "approval-canary" });
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    const thirdRequest = JSON.parse(String(f.fetchMock.mock.calls[2][1]?.body));
    expect(JSON.stringify(thirdRequest.messages)).toContain(privateConversation);
    expect(JSON.stringify(thirdRequest.messages)).toContain(privateEvidence);
    expect(thirdRequest.messages.at(-1).content).toBe('{"error":"INVALID_ARGUMENTS"}');
    expect(p.port.prepare).toHaveBeenCalledOnce();
    const preparation = vi.mocked(p.port.prepare).mock.calls[0];
    expect(preparation[1]).toBe("run-acceptance:publication:3");
    expect(preparation[2]).toEqual(selection);
    expect(preparation[3]).toEqual([{ kind: "brain", id: "private-source-canary" }]);
    expect(JSON.stringify(preparation.slice(1))).not.toContain(privateConversation);
    expect(JSON.stringify(preparation.slice(1))).not.toContain(privateEvidence);
    expect(p.port.commit).not.toHaveBeenCalled();

    p.approve();
    const completed = await f.runner().run();
    expect(completed).toEqual({ status: "completed", content: "Selected conclusion saved", receiptIds: ["synthetic-receipt"] });
    expect(p.port.commit).toHaveBeenCalledExactlyOnceWith(expect.anything(), preparation[1], { id: "approval-canary", selectionDigest: "synthetic-exact-selection" }, selection);
    expect(f.reservations).toEqual({ model: 4, tool: 1 });
    const authorizationCount = vi.mocked(f.runtime.authorize).mock.calls.length;
    await expect(f.runner().run()).resolves.toEqual(completed);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    expect(f.reservations).toEqual({ model: 4, tool: 1 });
    expect(p.port.commit).toHaveBeenCalledOnce();
    expect(vi.mocked(f.runtime.authorize).mock.calls.slice(authorizationCount)).toContainEqual(["result", [{ kind: "brain", id: "private-source-canary" }]]);
    f.authority.revokedSources.add("private-source-canary");
    await expect(f.runner().run()).rejects.toThrow("SCOPE");
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    expect(p.port.commit).toHaveBeenCalledOnce();
  });

  it("holds a saved proposal when membership changes during awaited approval, then resumes once", async () => {
    const p = publication();
    const f = await acceptanceFixture({ capabilities: { reads: [], publication: p.port } });
    f.fetchMock.mockResolvedValueOnce(success("", [toolCall("publish_selection", { result: "Exact approved conclusion" })]))
      .mockResolvedValueOnce(success("Saved once"));
    await expect(f.runner().run(input)).resolves.toMatchObject({ status: "waiting" });
    const entered = barrier();
    const released = barrier();
    vi.mocked(p.port.decision).mockImplementationOnce(async () => {
      entered.release();
      await released.promise;
      return "APPROVED";
    });
    const pending = f.runner().run();
    const rejected = expect(pending).rejects.toThrow("SCOPE");
    await entered.promise;
    f.authority.member = false;
    released.release();
    await rejected;
    expect(p.port.inspect).not.toHaveBeenCalled();
    expect(p.port.commit).not.toHaveBeenCalled();
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.reservations).toEqual({ model: 1, tool: 0 });
    f.authority.member = true;
    p.approve();
    await expect(f.runner().run()).resolves.toMatchObject({ status: "completed", receiptIds: ["synthetic-receipt"] });
    expect(p.port.prepare).toHaveBeenCalledOnce();
    expect(p.port.commit).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reconciles an acknowledged synthetic commit after post-commit authority loss without republishing", async () => {
    const p = publication();
    const f = await acceptanceFixture({ capabilities: { reads: [], publication: p.port } });
    f.fetchMock.mockResolvedValueOnce(success("", [toolCall("publish_selection", { result: "Publish once" })]))
      .mockResolvedValueOnce(success("Recovered receipt"));
    await f.runner().run(input);
    p.approve();
    const committed = barrier();
    const acknowledge = barrier();
    let hasSyntheticReceipt = false;
    vi.mocked(p.port.inspect).mockImplementation(async () => hasSyntheticReceipt
      ? { status: "COMMITTED", receiptId: "synthetic-receipt" }
      : { status: "NOT_COMMITTED" });
    vi.mocked(p.port.commit).mockImplementation(async () => {
      hasSyntheticReceipt = true;
      committed.release();
      await acknowledge.promise;
      return { status: "COMMITTED", receiptId: "synthetic-receipt" };
    });
    const pending = f.runner().run();
    const rejected = expect(pending).rejects.toThrow("SCOPE");
    await committed.promise;
    f.authority.member = false;
    acknowledge.release();
    await rejected;
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(p.port.commit).toHaveBeenCalledOnce();
    f.authority.member = true;
    await expect(f.runner().run()).resolves.toEqual({ status: "completed", content: "Recovered receipt", receiptIds: ["synthetic-receipt"] });
    expect(p.port.inspect).toHaveBeenCalledTimes(2);
    expect(p.port.commit).toHaveBeenCalledOnce();
    expect(p.port.prepare).toHaveBeenCalledOnce();
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    expect(f.reservations).toEqual({ model: 2, tool: 0 });
  });
});
