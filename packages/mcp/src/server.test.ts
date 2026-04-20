import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpendMock = vi.fn();
const submitSpendMock = vi.fn();

vi.mock("@corgtex/domain", () => ({
  listProposals: vi.fn(),
  createProposal: vi.fn(),
  listActions: vi.fn(),
  createAction: vi.fn(),
  listTensions: vi.fn(),
  createTension: vi.fn(),
  listMembers: vi.fn(),
  listMeetings: vi.fn(),
  getCurrentConstitution: vi.fn(),
  listPolicyCorpus: vi.fn(),
  createSpend: createSpendMock,
  submitSpend: submitSpendMock,
  listSpends: vi.fn(),
  listLedgerAccounts: vi.fn(),
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: vi.fn(),
}));

vi.mock("@corgtex/agents", () => ({
  processConversationTurn: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {},
  env: { APP_URL: "https://app.test" },
}));

vi.mock("./auth", () => ({
  requireScope: vi.fn(),
}));

describe("createCorgtexMcpServer", () => {
  beforeEach(() => {
    createSpendMock.mockReset().mockResolvedValue({ id: "spend-1" });
    submitSpendMock.mockReset().mockResolvedValue({
      spendId: "spend-1",
    });
  });

  it("returns the submitted spend identifier from create_spend", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
    });

    const createSpendTool = (server as any)._registeredTools.create_spend;
    const response = await createSpendTool.handler({
      amountCents: 1500,
      currency: "USD",
      category: "software",
      description: "Copilot",
      requesterEmail: "user@example.com",
    });

    expect(createSpendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        amountCents: 1500,
        currency: "USD",
        category: "software",
        description: "Copilot",
        requesterEmail: "user@example.com",
      }),
    );
    expect(submitSpendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      { workspaceId: "ws-1", spendId: "spend-1" },
    );
    expect(JSON.parse(response.content[0].text)).toEqual({
      id: "spend-1",
      status: "SUBMITTED",
      webUrl: "https://app.test/workspaces/ws-1/finance/spend/spend-1",
    });
  });
});
