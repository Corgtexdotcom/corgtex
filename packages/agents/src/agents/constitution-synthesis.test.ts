import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConstitutionVersion: vi.fn(),
  loadConstitutionCorpusSnapshot: vi.fn(), getCurrentConstitution: vi.fn(), captureArtifactInputProof: vi.fn(), isArtifactInputProofReadable: vi.fn(),
  chat: vi.fn(),
  executeAgentRun: vi.fn(),
  prisma: { constitution: { findFirst: vi.fn() } },
}));

vi.mock("@corgtex/shared", () => ({ prisma: mocks.prisma }));
vi.mock("@corgtex/domain", () => ({
  createConstitutionVersion: mocks.createConstitutionVersion,
  loadConstitutionCorpusSnapshot: mocks.loadConstitutionCorpusSnapshot,
  getCurrentConstitution: mocks.getCurrentConstitution, captureArtifactInputProof: mocks.captureArtifactInputProof,
  isArtifactInputProofReadable: mocks.isArtifactInputProofReadable,
  invariant: (condition: unknown, _status: number, _code: string, message: string) => { if (!condition) throw new Error(message); },
}));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { chat: mocks.chat } }));
vi.mock("../runtime", () => ({ executeAgentRun: mocks.executeAgentRun }));

import { runConstitutionSynthesisAgent } from "./constitution-synthesis";

const bodyMd = `# Constitution\n\nMission, Vision, Purpose\n\n${Array.from({ length: 10 }, (_, index) => `## ${index + 1}. Point ${index + 1}\n\nSupported text.`).join("\n\n")}`;
const pointSources = Array.from({ length: 10 }, (_, index) => ({
  pointOrder: index + 1,
  policyCorpusIds: index === 0 ? ["policy-1"] : [],
}));
const corpusFingerprint = "a".repeat(64);

describe("runConstitutionSynthesisAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConstitutionCorpusSnapshot.mockResolvedValue({
      corpus: [{
        id: "policy-1",
        title: "Policy",
        bodyMd: "Policy body",
        acceptedAt: new Date("2026-08-10T00:00:00.000Z"),
        circle: { id: "foreign-circle", name: "DO NOT DISCLOSE CIRCLE" },
        proposal: {
          id: "foreign-proposal",
          title: "DO NOT DISCLOSE PROPOSAL",
          tensions: [{ id: "foreign-tension", title: "DO NOT DISCLOSE TENSION" }],
        },
      }],
      fingerprint: corpusFingerprint,
    });
    mocks.getCurrentConstitution.mockResolvedValue(null);
    mocks.captureArtifactInputProof.mockResolvedValue([{ kind: "PolicyCorpus", id: "policy-1", fingerprint: "b".repeat(64) }]);
    mocks.isArtifactInputProofReadable.mockResolvedValue(true);
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({ bodyMd, pointSources }),
      usage: { model: "model-1", inputTokens: 10, outputTokens: 20 },
    });
    mocks.createConstitutionVersion.mockResolvedValue({ id: "constitution-1", version: 1 });
    mocks.executeAgentRun.mockImplementation(async (config) => {
      const helpers = {
        plannedInputReceipt: { kind: "agent-input-receipt" }, behaviorContext: null, behaviorLineageRoots: [],
        captureInputs: async () => ({ kind: "agent-input-receipt" }),
        tool: async (_name: string, _meta: unknown, callback: () => Promise<unknown>) => callback(),
        step: async (_name: string, _meta: unknown, callback: () => Promise<unknown>) => callback(),
      };
      const context = await config.buildContext(helpers);
      return config.execute(context, helpers, "run-1", "model-1");
    });
  });

  it("persists with the fingerprint captured from the exact synthesis corpus", async () => {
    await runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" });

    expect(mocks.loadConstitutionCorpusSnapshot).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent", workspaceIds: ["ws-1"] }), mocks.prisma, "ws-1");
    expect(mocks.createConstitutionVersion).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      bodyMd,
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" }],
      expectedCorpusFingerprint: corpusFingerprint,
    }));
    const synthesisPrompt = mocks.chat.mock.calls[0]?.[0]?.messages?.[1]?.content;
    expect(synthesisPrompt).toContain("Policy body");
    expect(synthesisPrompt).toContain("policy-1");
    expect(synthesisPrompt).not.toContain("DO NOT DISCLOSE");
  });

  it("rejects invented policy sources before creating a Constitution version", async () => {
    mocks.chat.mockResolvedValue({
      content: JSON.stringify({ bodyMd, pointSources: [{ pointOrder: 1, policyCorpusIds: ["other-workspace"] }, ...pointSources.slice(1)] }),
      usage: { model: "model-1", inputTokens: 10, outputTokens: 20 },
    });

    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" }))
      .rejects.toThrow("Invalid Constitution source mapping.");
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["out-of-order points", { bodyMd, pointSources: [pointSources[1], pointSources[0], ...pointSources.slice(2)] }],
    ["duplicate source IDs", { bodyMd, pointSources: [{ pointOrder: 1, policyCorpusIds: ["policy-1", "policy-1"] }, ...pointSources.slice(1)] }],
    ["arbitrary proposal IDs", { bodyMd, pointSources: [{ ...pointSources[0], proposalId: "foreign-proposal" }, ...pointSources.slice(1)] }],
    ["uncited points", { bodyMd, pointSources: pointSources.map((point) => ({ ...point, policyCorpusIds: [] })) }],
  ])("rejects %s before persistence", async (_case, output) => {
    mocks.chat.mockResolvedValue({ content: JSON.stringify(output), usage: {} });

    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" })).rejects.toThrow();
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });

  it("rejects malformed point headings before persistence", async () => {
    mocks.chat.mockResolvedValue({ content: JSON.stringify({ bodyMd: bodyMd.replace("## 10.", "## 11."), pointSources }), usage: {} });

    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" }))
      .rejects.toThrow("Invalid Constitution point order.");
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });

  it("requires the exact corpus fingerprint before asking the model", async () => {
    mocks.loadConstitutionCorpusSnapshot.mockResolvedValueOnce({ corpus: [{ id: "policy-1" }], fingerprint: null });

    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" }))
      .rejects.toThrow("Constitution synthesis requires a verified policy corpus fingerprint.");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });
  it("captures the full admitted corpus including uncited policies and the consumed prior Constitution before either model", async () => {
    const policies = [{ id: "policy-1", title: "One", bodyMd: "Body one", acceptedAt: new Date() },
      { id: "policy-2", title: "Two", bodyMd: "Uncited body two", acceptedAt: new Date() }];
    const prior = { id: "prior-1", version: 2, bodyMd: "Previous known body", createdAt: new Date() };
    const roots = [{ kind: "PolicyCorpus", id: "policy-1", fingerprint: "b".repeat(64) },
      { kind: "PolicyCorpus", id: "policy-2", fingerprint: "c".repeat(64) },
      { kind: "Constitution", id: prior.id, fingerprint: "d".repeat(64) }];
    mocks.loadConstitutionCorpusSnapshot.mockResolvedValue({ corpus: policies, fingerprint: corpusFingerprint });
    mocks.getCurrentConstitution.mockResolvedValue(prior);
    mocks.captureArtifactInputProof.mockResolvedValue(roots);
    mocks.chat.mockImplementation(async () => {
      expect(mocks.captureArtifactInputProof).toHaveBeenCalled();
      return { content: JSON.stringify({ bodyMd, pointSources }), usage: { model: "model-1" } };
    });
    await runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "trigger" });
    expect(mocks.captureArtifactInputProof).toHaveBeenCalledWith(expect.any(Object), "ws-1", [
      { kind: "PolicyCorpus", id: "policy-1", snapshot: policies[0] },
      { kind: "PolicyCorpus", id: "policy-2", snapshot: policies[1] },
      { kind: "Constitution", id: prior.id, snapshot: prior },
    ]);
    expect(mocks.chat).toHaveBeenCalledTimes(2);
    expect(mocks.createConstitutionVersion).toHaveBeenCalledWith(expect.objectContaining({ lineageRoots: roots,
      lineageActor: expect.objectContaining({ label: "constitution-synthesis", workspaceIds: ["ws-1"] }) }));
  });

  it("uses the first-version prompt when no prior version has a complete readable proof", async () => {
    mocks.getCurrentConstitution.mockResolvedValue(null);
    await runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "trigger" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.chat.mock.calls[0][0].messages[0].content).toContain("FIRST constitution");
    expect(JSON.parse(mocks.chat.mock.calls[0][0].messages[1].content).currentConstitution).toBeNull();
  });

  it("withholds stale input context before the first model call", async () => {
    mocks.isArtifactInputProofReadable.mockResolvedValue(false);
    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "trigger" })).rejects.toThrow("inputs are unavailable");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });

  it("rechecks all inputs before the second model call and blocks persistence after revocation", async () => {
    mocks.getCurrentConstitution.mockResolvedValue({ id: "prior", version: 2, bodyMd: "Known prior", createdAt: new Date() });
    mocks.isArtifactInputProofReadable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "trigger" })).rejects.toThrow("summary inputs changed");
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.createConstitutionVersion).not.toHaveBeenCalled();
  });

});
