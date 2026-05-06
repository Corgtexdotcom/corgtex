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
        findFirst: vi.fn(),
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
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      crmActivity: {
        create: vi.fn(),
      },
      workspace: {
        create: vi.fn(),
      },
      customerAccount: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      customerDeployment: {
        upsert: vi.fn(),
      },
      $transaction: vi.fn((fn: any) =>
        fn({
          crmQualification: {
            create: vi.fn().mockResolvedValue({ id: "qual-1", workspaceId: "ws-1", status: "PENDING_REVIEW" }),
            update: vi.fn().mockResolvedValue({ id: "qual-1", status: "APPROVED" }),
          },
          workspace: {
            upsert: vi.fn().mockResolvedValue({ id: "ws-1", slug: "corgtex", name: "Corgtex" }),
            create: vi.fn().mockResolvedValue({ id: "ws-new", name: "Demo Workspace", slug: "demo-123" }),
          },
          customerAccount: {
            upsert: vi.fn().mockResolvedValue({ id: "cust-1", slug: "demo-123", primaryDeploymentId: null }),
            findUnique: vi.fn().mockResolvedValue({ id: "cust-1", primaryDeploymentId: null }),
            update: vi.fn().mockResolvedValue({ id: "cust-1", primaryDeploymentId: "inst-1" }),
          },
          customerDeployment: {
            upsert: vi.fn().mockResolvedValue({ id: "inst-1", customerSlug: "demo-123" }),
          },
          demoLead: {
            upsert: vi.fn().mockResolvedValue({
              id: "lead-1",
              workspaceId: "ws-1",
              email: "demo@example.com",
              welcomeEmailSentAt: null,
            }),
            update: vi.fn().mockResolvedValue({ id: "lead-1" }),
          },
          crmContact: {
            upsert: vi.fn().mockResolvedValue({ id: "contact-1" }),
            updateMany: vi.fn(),
          },
          crmActivity: {
            create: vi.fn().mockResolvedValue({ id: "activity-1" }),
          },
          crmConversationMessage: {
            create: vi.fn().mockResolvedValue({ id: "msg-1", conversationId: "conv-1" }),
          },
          crmConversation: {
            update: vi.fn(),
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

  describe("captureDemoLead", () => {
    it("emits a welcome newspaper event for leads that have not received one", async () => {
      const { appendEvents } = await import("./events");
      const { captureDemoLead } = await import("./crm");

      await captureDemoLead({ email: "Demo@Example.com" });

      expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({
          workspaceId: "ws-1",
          type: "demo-lead.captured",
          aggregateType: "DemoLead",
          aggregateId: "lead-1",
          payload: {
            demoLeadId: "lead-1",
            email: "demo@example.com",
            source: "demo_gate",
          },
        }),
      ]);
    });

    it("does not emit the welcome event after the welcome newspaper was sent", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { appendEvents } = await import("./events");
      const { captureDemoLead } = await import("./crm");

      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) =>
        fn({
          workspace: {
            upsert: vi.fn().mockResolvedValue({ id: "ws-1", slug: "corgtex", name: "Corgtex" }),
          },
          demoLead: {
            upsert: vi.fn().mockResolvedValue({
              id: "lead-1",
              workspaceId: "ws-1",
              email: "demo@example.com",
              welcomeEmailSentAt: new Date("2026-04-30T12:00:00.000Z"),
            }),
          },
          crmContact: {
            upsert: vi.fn().mockResolvedValue({ id: "contact-1" }),
          },
        })) as any);

      await captureDemoLead({ email: "demo@example.com" });

      expect(appendEvents).not.toHaveBeenCalled();
    });
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

  describe("applyExtractionResult", () => {
    it("updates only null fields", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { applyExtractionResult } = await import("./crm-extraction");

      vi.mocked(prisma.crmQualification.findFirst).mockResolvedValue({
        id: "qual-1",
        workspaceId: "ws-1",
        companyName: null,
        website: "https://existing.com",
        aiExperience: null,
        helpNeeded: null,
      } as any);

      await applyExtractionResult("ws-1", "qual-1", {
        companyName: "Extracted Corp",
        website: "https://new.com",
        aiExperience: "Beginner",
      });

      expect(prisma.crmQualification.update).toHaveBeenCalledWith({
        where: { id: "qual-1" },
        data: {
          companyName: "Extracted Corp",
          aiExperience: "Beginner",
        },
      });
    });
  });

  describe("applyEnrichmentResult", () => {
    it("adds high-confidence enrichment as tags and records an activity", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { applyEnrichmentResult } = await import("./crm-enrichment");

      vi.mocked(prisma.crmContact.findFirst).mockResolvedValue({
        id: "contact-1",
        workspaceId: "ws-1",
        tags: ["existing"],
      } as any);

      await applyEnrichmentResult("ws-1", "contact-1", {
        industry: "Healthcare",
        headquarters: "New York",
        description: "Care delivery platform",
        confidence: 0.91,
      });

      expect(prisma.crmContact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "contact-1",
          workspaceId: "ws-1",
        },
      });
      expect(prisma.crmContact.update).toHaveBeenCalledWith({
        where: { id: "contact-1" },
        data: { tags: ["existing", "Healthcare", "New York"] },
      });
      expect(prisma.crmActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            contactId: "contact-1",
            title: "Applied Enrichment Data",
          }),
        }),
      );
    });
  });

  describe("recordDripFollowUp", () => {
    it("scopes the lead lookup to the workspace before recording the follow-up", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { recordDripFollowUp } = await import("./crm-drip");

      vi.mocked(prisma.demoLead.findFirst).mockResolvedValue({
        id: "lead-1",
        workspaceId: "ws-1",
        followUpCount: 1,
        convertedContactId: "contact-1",
      } as any);

      await recordDripFollowUp("ws-1", "lead-1", "Checking in.");

      expect(prisma.demoLead.findFirst).toHaveBeenCalledWith({
        where: {
          id: "lead-1",
          workspaceId: "ws-1",
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });
});
