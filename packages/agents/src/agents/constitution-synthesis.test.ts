import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConstitutionVersion: vi.fn(),
  loadConstitutionCorpusSnapshot: vi.fn(),
  chat: vi.fn(),
  executeAgentRun: vi.fn(),
  prisma: { constitution: { findFirst: vi.fn() } },
}));

vi.mock("@corgtex/shared", () => ({ prisma: mocks.prisma }));
vi.mock("@corgtex/domain", () => ({
  createConstitutionVersion: mocks.createConstitutionVersion,
  loadConstitutionCorpusSnapshot: mocks.loadConstitutionCorpusSnapshot,
}));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { chat: mocks.chat } }));
vi.mock("../runtime", () => ({ executeAgentRun: mocks.executeAgentRun }));

import { runConstitutionSynthesisAgent } from "./constitution-synthesis";

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
      fingerprint: "corpus-fingerprint",
    });
    mocks.prisma.constitution.findFirst.mockResolvedValue(null);
    mocks.chat.mockResolvedValue({
      content: "# Constitution",
      usage: { model: "model-1", inputTokens: 10, outputTokens: 20 },
    });
    mocks.createConstitutionVersion.mockResolvedValue({ id: "constitution-1", version: 1 });
    mocks.executeAgentRun.mockImplementation(async (config) => {
      const helpers = {
        tool: async (_name: string, _meta: unknown, callback: () => Promise<unknown>) => callback(),
        step: async (_name: string, _meta: unknown, callback: () => Promise<unknown>) => callback(),
      };
      const context = await config.buildContext(helpers);
      return config.execute(context, helpers, "run-1", "model-1");
    });
  });

  it("persists with the fingerprint captured from the exact synthesis corpus", async () => {
    await runConstitutionSynthesisAgent({ workspaceId: "ws-1", triggerRef: "proposal-1" });

    expect(mocks.loadConstitutionCorpusSnapshot).toHaveBeenCalledWith(mocks.prisma, "ws-1");
    expect(mocks.createConstitutionVersion).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      bodyMd: "# Constitution",
      expectedCorpusFingerprint: "corpus-fingerprint",
    }));
    const synthesisPrompt = mocks.chat.mock.calls[0]?.[0]?.messages?.[1]?.content;
    expect(synthesisPrompt).toContain("Policy body");
    expect(synthesisPrompt).not.toContain("DO NOT DISCLOSE");
  });
});
