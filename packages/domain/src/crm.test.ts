import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------- mocks ----------

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      demoLead: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      crmQualification: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      crmConversation: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      crmConversationMessage: {
        create: vi.fn(),
      },
      crmProspectWorkspace: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      crmContact: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
      workspace: {
        create: vi.fn(),
      },
      $transaction: vi.fn((fn: any) =>
        fn({
          crmQualification: {
            create: vi.fn().mockResolvedValue({ id: "qual-1", workspaceId: "ws-1", status: "PENDING_REVIEW" }),
            update: vi.fn().mockResolvedValue({ id: "qual-1", status: "APPROVED" }),
          },
          crmContact: { updateMany: vi.fn() },
          crmConversationMessage: {
            create: vi.fn().mockResolvedValue({ id: "msg-1", conversationId: "conv-1" }),
          },
          crmConversation: {
            update: vi.fn(),
          },
          workspace: {
            create: vi.fn().mockResolvedValue({ id: "ws-new", name: "Demo Workspace" }),
          },
          crmProspectWorkspace: {
            create: vi.fn().mockResolvedValue({ id: "pw-1", crmWorkspaceId: "ws-1", targetWorkspaceId: "ws-new" }),
          },
        })
      ),
    },
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(undefined),
}));

const dummyActor = { kind: "user", user: { id: "u-1", email: "admin@corgtex.local" } } as any;

// ---------- tests ----------

describe("CRM domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- submitQualification ---
  describe("submitQualification", () => {
    it("creates a qualification record from a valid token", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { submitQualification } = await import("./crm");

      vi.mocked(prisma.demoLead.findUnique).mockResolvedValue({
        id: "lead-1",
        email: "demo@acme.com",
        workspaceId: "ws-1",
        workspace: { id: "ws-1" },
      } as any);

      const result = await submitQualification({
        token: "tok_abc",
        companyName: "Acme Corp",
        website: "acme.com",
        aiExperience: "Tried ChatGPT",
        helpNeeded: "Internal knowledge base",
      });

      expect(prisma.demoLead.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { qualifyToken: "tok_abc" },
        })
      );
      expect(result).toBeDefined();
      expect(result.id).toBe("qual-1");
    });

    it("throws for an invalid token", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { submitQualification } = await import("./crm");

      vi.mocked(prisma.demoLead.findUnique).mockResolvedValue(null);

      await expect(
        submitQualification({
          token: "bad_token",
          companyName: "X",
          website: "x.com",
          aiExperience: "none",
          helpNeeded: "everything",
        })
      ).rejects.toThrow();
    });
  });

  // --- receiveEmailReply ---
  describe("receiveEmailReply", () => {
    it("creates a qualification from an inbound email", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { receiveEmailReply } = await import("./crm");

      vi.mocked(prisma.demoLead.findFirst).mockResolvedValue({
        id: "lead-2",
        email: "ceo@startup.io",
        workspaceId: "ws-1",
      } as any);

      const result = await receiveEmailReply({
        fromEmail: "CEO@Startup.IO",
        subject: "Re: Welcome to Corgtex",
        bodyText: "Company: Startup Inc\nWebsite: startup.io\nAI experience: basic",
      });

      expect(prisma.demoLead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: "ceo@startup.io" },
        })
      );
      expect(result).toBeDefined();
    });

    it("throws when no matching lead is found", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { receiveEmailReply } = await import("./crm");

      vi.mocked(prisma.demoLead.findFirst).mockResolvedValue(null);

      await expect(
        receiveEmailReply({
          fromEmail: "unknown@nowhere.com",
          subject: "Hi",
          bodyText: "Hello",
        })
      ).rejects.toThrow();
    });
  });

  // --- approveQualification ---
  describe("approveQualification", () => {
    it("transitions a pending qualification to APPROVED", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { approveQualification } = await import("./crm");

      vi.mocked(prisma.crmQualification.findUnique).mockResolvedValue({
        id: "qual-1",
        workspaceId: "ws-1",
        status: "PENDING_REVIEW",
        companyName: "Acme",
        website: "acme.com",
        demoLead: { email: "demo@acme.com" },
      } as any);

      const result = await approveQualification(dummyActor, {
        workspaceId: "ws-1",
        qualificationId: "qual-1",
      });

      expect(prisma.crmQualification.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "qual-1" } })
      );
      expect(result).toBeDefined();
    });

    it("rejects a non-pending qualification", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { approveQualification } = await import("./crm");

      vi.mocked(prisma.crmQualification.findUnique).mockResolvedValue({
        id: "qual-1",
        workspaceId: "ws-1",
        status: "APPROVED",
        demoLead: { email: "demo@acme.com" },
      } as any);

      await expect(
        approveQualification(dummyActor, {
          workspaceId: "ws-1",
          qualificationId: "qual-1",
        })
      ).rejects.toThrow();
    });
  });

  // --- rejectQualification ---
  describe("rejectQualification", () => {
    it("transitions a pending qualification to REJECTED", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { rejectQualification } = await import("./crm");

      vi.mocked(prisma.crmQualification.findUnique).mockResolvedValue({
        id: "qual-2",
        workspaceId: "ws-1",
        status: "PENDING_REVIEW",
        demoLead: { email: "demo@acme.com" }
      } as any);

      const result = await rejectQualification(dummyActor, {
        workspaceId: "ws-1",
        qualificationId: "qual-2",
        note: "Not a good fit",
      });

      expect(result).toBeDefined();
    });
  });

  // --- listQualifications ---
  describe("listQualifications", () => {
    it("returns paginated qualifications with lead data", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listQualifications } = await import("./crm");

      vi.mocked(prisma.crmQualification.findMany).mockResolvedValue([
        { id: "q1", status: "PENDING_REVIEW", demoLead: { email: "a@b.com" } },
      ] as any);
      vi.mocked(prisma.crmQualification.count).mockResolvedValue(1);

      const result = await listQualifications(dummyActor, "ws-1", { status: "PENDING_REVIEW" });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // --- syncEmailReplyToConversation ---
  describe("syncEmailReplyToConversation", () => {
    it("returns null when no lead is found", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { syncEmailReplyToConversation } = await import("./crm");

      vi.mocked(prisma.demoLead.findFirst).mockResolvedValue(null);

      const result = await syncEmailReplyToConversation({
        fromEmail: "nobody@ghost.com",
        subject: "Hello",
        bodyText: "Hi",
      });

      expect(result).toBeNull();
    });
  });

  // --- provisionProspectWorkspace ---
  describe("provisionProspectWorkspace", () => {
    it("creates a new workspace and links it to the demo lead", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { provisionProspectWorkspace } = await import("./crm");

      vi.mocked(prisma.demoLead.findUnique).mockResolvedValue({
        id: "lead-1",
        email: "demo@acme.com",
        workspaceId: "ws-1",
      } as any);

      vi.mocked(prisma.crmProspectWorkspace.findFirst).mockResolvedValue(null);

      const result = await provisionProspectWorkspace(dummyActor, {
        demoLeadId: "lead-1",
        adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1",
      });

      expect(prisma.demoLead.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "lead-1" } })
      );
      expect(result).toBeDefined();
    });

    it("returns existing workspace if already provisioned", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { provisionProspectWorkspace } = await import("./crm");

      vi.mocked(prisma.demoLead.findUnique).mockResolvedValue({
        id: "lead-1",
        email: "demo@acme.com",
        workspaceId: "ws-1",
      } as any);

      const existing = { id: "pw-existing", crmWorkspaceId: "ws-1", demoLeadId: "lead-1" };
      vi.mocked(prisma.crmProspectWorkspace.findFirst).mockResolvedValue(existing as any);

      const result = await provisionProspectWorkspace(dummyActor, {
        demoLeadId: "lead-1",
        adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1",
      });

      expect(result).toEqual(existing);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects non-user actors", async () => {
      const { provisionProspectWorkspace } = await import("./crm");

      const agentActor = { kind: "agent", agent: { id: "a-1" } } as any;

      await expect(
        provisionProspectWorkspace(agentActor, {
          demoLeadId: "lead-1",
          adminEmail: "admin@acme.com",
          crmWorkspaceId: "ws-1",
        })
      ).rejects.toThrow();
    });
  });
});
