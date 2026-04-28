import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpendMock = vi.fn();
const submitSpendMock = vi.fn();
const createMemberMock = vi.fn();
const bulkInviteMembersMock = vi.fn();
const sendMemberSetupEmailMock = vi.fn();

vi.mock("@corgtex/domain", () => ({
  listProposals: vi.fn(),
  createProposal: vi.fn(),
  listActions: vi.fn(),
  createAction: vi.fn(),
  listTensions: vi.fn(),
  createTension: vi.fn(),
  listMembers: vi.fn(),
  createMember: createMemberMock,
  bulkInviteMembers: bulkInviteMembersMock,
  sendMemberSetupEmail: sendMemberSetupEmailMock,
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
    createMemberMock.mockReset().mockResolvedValue({
      user: { id: "user-1", email: "new@example.com", displayName: "New Person" },
      member: { id: "member-1", role: "CONTRIBUTOR" },
      token: "member-setup-token",
    });
    bulkInviteMembersMock.mockReset().mockResolvedValue({
      invited: 1,
      details: [{ email: "new@example.com", displayName: "New Person", token: "bulk-setup-token" }],
      errors: [],
    });
    sendMemberSetupEmailMock.mockReset().mockResolvedValue({ email: "new@example.com", sent: true });
  });

  it("returns the opened spend identifier from create_spend", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
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
      status: "OPEN",
      webUrl: "https://app.test/workspaces/ws-1/finance/spend/spend-1",
    });
  });

  it("annotates read-only and destructive tools for connector approval reviews", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "bootstrap" } as any,
      workspaceId: "ws-1",
      authKind: "agent",
    });

    expect((server as any)._registeredTools.search.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.fetch.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((server as any)._registeredTools.delete_action.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("emails setup links from create_member without returning raw setup tokens", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "credential", scopes: ["members:write"] } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["members:write"],
    });

    const createMemberTool = (server as any)._registeredTools.create_member;
    const response = await createMemberTool.handler({
      email: "new@example.com",
      displayName: "New Person",
      role: "CONTRIBUTOR",
    });
    const body = JSON.parse(response.content[0].text);

    expect(createMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        email: "new@example.com",
        skipAdminCheck: true,
      }),
    );
    expect(sendMemberSetupEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      email: "new@example.com",
      token: "member-setup-token",
    }));
    expect(body).toMatchObject({
      id: "member-1",
      email: "new@example.com",
      emailStatus: { email: "new@example.com", sent: true },
    });
    expect(JSON.stringify(body)).not.toContain("member-setup-token");
  });

  it("registers bulk_invite_members only when members:write is available", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const readOnlyServer = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "credential", scopes: ["members:read"] } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["members:read"],
    });
    expect((readOnlyServer as any)._registeredTools.bulk_invite_members).toBeUndefined();

    const writableServer = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "credential", scopes: ["members:write"] } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["members:write"],
    });
    expect((writableServer as any)._registeredTools.bulk_invite_members).toBeDefined();
  });

  it("bulk_invite_members returns delivery status and hides setup tokens", async () => {
    const { createCorgtexMcpServer } = await import("./server");

    const server = createCorgtexMcpServer({
      actor: { kind: "agent", authProvider: "credential", scopes: ["members:write"] } as any,
      workspaceId: "ws-1",
      authKind: "agent",
      scopes: ["members:write"],
    });

    const bulkInviteTool = (server as any)._registeredTools.bulk_invite_members;
    const response = await bulkInviteTool.handler({
      members: [{ email: "new@example.com", displayName: "New Person" }],
    });
    const body = JSON.parse(response.content[0].text);

    expect(bulkInviteMembersMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        workspaceId: "ws-1",
        members: [{ email: "new@example.com", displayName: "New Person" }],
        skipAdminCheck: true,
      },
    );
    expect(body).toMatchObject({
      invited: 1,
      details: [{ email: "new@example.com", displayName: "New Person" }],
      emailStatus: [{ email: "new@example.com", sent: true }],
    });
    expect(JSON.stringify(body)).not.toContain("bulk-setup-token");
  });
});
