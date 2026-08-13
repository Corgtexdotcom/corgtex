import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------- mocks ----------

const archiveWorkspaceArtifact = vi.fn().mockResolvedValue({ id: "archive-1" });
const lockWorkspaceArchiveArtifact = vi.fn().mockResolvedValue(undefined);

vi.mock("@corgtex/shared", () => {
  return {
    env: {
      APP_URL: "https://app.corgtex.test",
    },
    toInputJson: vi.fn((value: unknown) => value),
    prisma: {
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
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
      crmAccount: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      crmContact: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      crmDeal: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      crmDealStageTransition: {
        create: vi.fn(),
      },
      crmActivity: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      crmCommunicationSuggestion: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      member: {
        findFirst: vi.fn(),
      },
      auditLog: {
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
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn((fn: any) =>
        fn({
          $executeRaw: vi.fn().mockResolvedValue(0),
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
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({ id: "inst-1", customerSlug: "demo-123" }),
          },
          demoLead: {
            upsert: vi.fn().mockResolvedValue({
              id: "lead-1",
              workspaceId: "ws-1",
              email: "demo@example.com",
              welcomeEmailSentAt: null,
            }),
            findUnique: vi.fn().mockResolvedValue({ id: "lead-1", email: "demo@example.com", workspaceId: "ws-1" }),
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn().mockResolvedValue({ id: "lead-1" }),
          },
          auditLog: {
            create: vi.fn().mockResolvedValue({ id: "audit-1" }),
          },
          crmAccount: {
            findFirst: vi.fn().mockResolvedValue(null),
            findUnique: vi.fn().mockResolvedValue({
              id: "account-1",
              workspaceId: "ws-1",
              archivedAt: null,
            }),
            create: vi.fn().mockResolvedValue({
              id: "account-1",
              workspaceId: "ws-1",
              name: "Example",
              slug: "example-com",
              domain: "example.com",
              relationshipType: "PROSPECT",
              lifecycleStage: "DISCOVERY",
            }),
            update: vi.fn().mockResolvedValue({
              id: "account-1",
              workspaceId: "ws-1",
              name: "Example",
              slug: "example-com",
              domain: "example.com",
              relationshipType: "PROSPECT",
              lifecycleStage: "DISCOVERY",
            }),
          },
          crmContact: {
            upsert: vi.fn().mockResolvedValue({ id: "contact-1" }),
            create: vi.fn().mockResolvedValue({ id: "contact-1", email: "demo@example.com", accountId: "account-1" }),
            findUnique: vi.fn().mockResolvedValue({
              id: "contact-1",
              workspaceId: "ws-1",
              accountId: "account-1",
              archivedAt: null,
            }),
            findFirst: vi.fn().mockResolvedValue({
              id: "contact-1",
              workspaceId: "ws-1",
              accountId: "account-1",
              archivedAt: null,
              tags: ["existing"],
            }),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi.fn().mockResolvedValue({
              id: "contact-1",
              email: "demo@example.com",
              accountId: "account-1",
            }),
            updateMany: vi.fn(),
          },
          crmDeal: {
            create: vi.fn().mockResolvedValue({
              id: "deal-1",
              workspaceId: "ws-1",
              accountId: "account-1",
              contactId: "contact-1",
              title: "Pilot",
              stage: "LEAD",
              createdAt: new Date("2026-06-01T00:00:00.000Z"),
            }),
            findUnique: vi.fn().mockResolvedValue({
              id: "deal-1",
              workspaceId: "ws-1",
              stage: "LEAD",
              archivedAt: null,
            }),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi.fn().mockResolvedValue({ id: "deal-1", workspaceId: "ws-1", stage: "QUALIFIED" }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmDealStageTransition: {
            create: vi.fn().mockResolvedValue({ id: "transition-1" }),
          },
          crmActivity: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn(),
            findUnique: vi.fn().mockResolvedValue({
              id: "activity-1",
              workspaceId: "ws-1",
              accountId: "account-1",
              contactId: null,
              dealId: null,
              source: "manual",
              completedAt: null,
            }),
            create: vi.fn().mockResolvedValue({ id: "activity-1" }),
            update: vi.fn().mockResolvedValue({ id: "activity-1", completedAt: new Date("2026-06-18T00:00:00.000Z") }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmCommunicationSuggestion: {
            findMany: vi.fn(),
            count: vi.fn(),
            findUnique: vi.fn().mockResolvedValue({
              id: "suggestion-1",
              workspaceId: "ws-1",
              accountId: "account-1",
              contactId: "contact-1",
              dealId: null,
              activityId: null,
              status: "SUGGESTED",
              title: "Send follow-up",
              subject: "Next steps",
              bodyMd: "Thanks for the walkthrough.",
              source: "manual",
              channel: "EMAIL",
            }),
            create: vi.fn().mockResolvedValue({
              id: "suggestion-1",
              workspaceId: "ws-1",
              status: "SUGGESTED",
              channel: "EMAIL",
            }),
            update: vi.fn().mockResolvedValue({
              id: "suggestion-1",
              workspaceId: "ws-1",
              status: "REQUESTED",
              channel: "EMAIL",
            }),
          },
          member: {
            findFirst: vi.fn().mockResolvedValue({ id: "member-1" }),
          },
          crmConversationMessage: {
            create: vi.fn().mockResolvedValue({ id: "msg-1", conversationId: "conv-1" }),
          },
          crmConversation: {
            findFirst: vi.fn().mockResolvedValue(null),
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "conv-1" }),
            update: vi.fn(),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmProspectWorkspace: {
            findMany: vi.fn(),
            count: vi.fn(),
            findUnique: vi.fn(),
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "pw-1", crmWorkspaceId: "ws-1", targetWorkspaceId: "ws-new" }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        })
      ),
    },
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue(true),
  requireGlobalOperator: vi.fn(),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./archive", () => ({
  archiveWorkspaceArtifact,
  lockWorkspaceArchiveArtifact,
  archiveFilterWhere: vi.fn((filter = "active") => {
    if (filter === "all") return {};
    if (filter === "archived") return { archivedAt: { not: null } };
    return { archivedAt: null };
  }),
}));

const dummyActor = { kind: "user", user: { id: "u-1", email: "admin@corgtex.local" } } as any;
const targetWorkspaceSlug = ["cr", "ina"].join("");

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
          crmAccount: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", domain: "example.com" }),
          },
          crmContact: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "contact-1" }),
          },
        })) as any);

      await captureDemoLead({ email: "demo@example.com" });

      expect(appendEvents).not.toHaveBeenCalled();
    });

    it("retries contact account-link drift and returns a controlled conflict without downstream writes", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { appendEvents } = await import("./events");
      const { captureDemoLead } = await import("./crm");
      const txFor = (beforeAccountId: string, afterAccountId: string) => ({
        workspace: { upsert: vi.fn().mockResolvedValue({ id: "ws-1" }) },
        demoLead: { upsert: vi.fn().mockResolvedValue({ id: "lead-1", welcomeEmailSentAt: null }) },
        crmAccount: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
        crmContact: {
          findUnique: vi.fn()
            .mockResolvedValueOnce({ id: "contact-1", workspaceId: "ws-1", accountId: beforeAccountId, archivedAt: null })
            .mockResolvedValueOnce({ id: "contact-1", workspaceId: "ws-1", accountId: afterAccountId, archivedAt: null }),
          findFirst: vi.fn(), create: vi.fn(), update: vi.fn(),
        },
      });
      const first = txFor("account-1", "account-2");
      const second = txFor("account-2", "account-3");
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce((async (fn: any) => fn(first)) as any)
        .mockImplementationOnce((async (fn: any) => fn(second)) as any);

      await expect(captureDemoLead({ email: "demo@example.com" })).rejects.toMatchObject({
        code: "CRM_LINK_CLOSURE_CHANGED",
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      for (const tx of [first, second]) {
        expect(tx.crmContact.findFirst).not.toHaveBeenCalled();
        expect(tx.crmContact.create).not.toHaveBeenCalled();
        expect(tx.crmContact.update).not.toHaveBeenCalled();
        expect(tx.crmAccount.create).not.toHaveBeenCalled();
      }
      expect(appendEvents).not.toHaveBeenCalled();
    });
  });

  describe("captureCrmInquiry", () => {
    function inquiryInput(overrides: Record<string, unknown> = {}) {
      return {
        workspaceSlug: targetWorkspaceSlug,
        source: "corporate_rebels_website",
        sourceExternalId: "form-001",
        persona: "OWNER",
        name: "Ava Chen",
        email: "Ava@Meridian.example",
        phone: "+1 555 0100",
        company: "Meridian Works",
        website: "https://meridian.example",
        title: "Owner",
        location: "Chicago",
        message: "I want to explore acquisition support.",
        answers: { timeline: "This quarter" },
        sourceUrl: "https://us.corporate-rebels.com/contact",
        referrerUrl: "https://us.corporate-rebels.com/",
        utmSource: "website",
        consentToContact: true,
        ...overrides,
      };
    }

    function inquiryTx(overrides: Record<string, any> = {}) {
      const tx = {
        workspace: {
          findUnique: vi.fn().mockResolvedValue({ id: "ws-1", slug: targetWorkspaceSlug }),
        },
        crmConversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "conv-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: "deal-1",
          }),
        },
        crmConversationMessage: {
          create: vi.fn().mockResolvedValue({ id: "msg-1", conversationId: "conv-1" }),
        },
        crmActivity: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "activity-1" }),
        },
        crmAccount: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Meridian Works",
            slug: "meridian-works",
            domain: "meridian.example",
            tags: ["source:corporate_rebels_website", "persona:owner"],
          }),
          update: vi.fn(),
        },
        crmContact: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            email: "ava@meridian.example",
            accountId: "account-1",
            tags: ["source:corporate_rebels_website", "persona:owner"],
          }),
          update: vi.fn(),
        },
        crmDeal: {
          create: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            title: "Meridian Works owner inquiry",
            stage: "LEAD",
            createdAt: new Date("2026-07-08T12:00:00.000Z"),
          }),
        },
        crmDealStageTransition: {
          create: vi.fn().mockResolvedValue({ id: "transition-1" }),
        },
        ...overrides,
      };
      return tx;
    }

    it("creates contact, account, conversation, task, and deal for owner inquiries", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
      try {
        const { prisma } = await import("@corgtex/shared");
        const { appendEvents } = await import("./events");
        const { captureCrmInquiry } = await import("./crm");
        const tx = inquiryTx();
        vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

        const result = await captureCrmInquiry(inquiryInput());

        expect(result).toEqual({
          duplicate: false,
          submissionId: "conv-1",
          workspaceId: "ws-1",
          contactId: "contact-1",
          accountId: "account-1",
          conversationId: "conv-1",
          messageId: "msg-1",
          activityId: "activity-1",
          dealId: "deal-1",
        });
        expect(tx.crmAccount.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            name: "Meridian Works",
            slug: "meridian-works",
            domain: "meridian.example",
            relationshipType: "PROSPECT",
            lifecycleStage: "DISCOVERY",
            tags: ["source:corporate_rebels_website", "persona:owner"],
          }),
        });
        expect(tx.crmContact.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            accountId: "account-1",
            email: "ava@meridian.example",
            name: "Ava Chen",
            company: "Meridian Works",
            source: "corporate_rebels_website",
            tags: ["source:corporate_rebels_website", "persona:owner"],
          }),
        });
        expect(tx.crmConversation.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: "deal-1",
            source: "corporate_rebels_website",
            sourceExternalId: "form-001",
          }),
        });
        expect(tx.crmConversationMessage.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            conversationId: "conv-1",
            senderType: "LEAD",
            senderEmail: "ava@meridian.example",
            bodyMd: expect.stringContaining("I want to explore acquisition support."),
          }),
        });
        expect(tx.crmActivity.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: "deal-1",
            type: "TASK",
            source: "corporate_rebels_website",
            sourceExternalId: "form-001:follow-up",
            dueAt: new Date("2026-07-10T17:00:00.000Z"),
          }),
        });
        expect(tx.crmDeal.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            stage: "LEAD",
          }),
        });
        expect(tx.crmDealStageTransition.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            dealId: "deal-1",
            fromStage: null,
            toStage: "LEAD",
            actorUserId: null,
          }),
        });
        expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
          expect.objectContaining({
            workspaceId: "ws-1",
            type: "crm.inquiry.captured",
            aggregateType: "CrmConversation",
            aggregateId: "conv-1",
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["GENERAL", "EMPLOYEE"])("creates no deal for %s inquiries", async (persona) => {
      const { prisma } = await import("@corgtex/shared");
      const { captureCrmInquiry } = await import("./crm");
      const tx = inquiryTx({
        crmConversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "conv-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: null,
          }),
        },
      });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await captureCrmInquiry(inquiryInput({ persona }));

      expect(result.dealId).toBeNull();
      expect(tx.crmDeal.create).not.toHaveBeenCalled();
      expect(tx.crmConversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          dealId: null,
        }),
      });
      expect(tx.crmActivity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          dealId: null,
        }),
      });
    });

    it("returns the existing submission for duplicate source ids without creating CRM records", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { appendEvents } = await import("./events");
      const { captureCrmInquiry } = await import("./crm");
      const tx = inquiryTx({
        crmConversation: {
          findUnique: vi.fn().mockResolvedValue({
            id: "conv-existing",
            accountId: "account-existing",
            contactId: "contact-existing",
            dealId: "deal-existing",
          }),
          create: vi.fn(),
        },
        crmActivity: {
          findUnique: vi.fn().mockResolvedValue({ id: "activity-existing" }),
          create: vi.fn(),
        },
      });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await captureCrmInquiry(inquiryInput());

      expect(result).toEqual({
        duplicate: true,
        submissionId: "conv-existing",
        workspaceId: "ws-1",
        contactId: "contact-existing",
        accountId: "account-existing",
        conversationId: "conv-existing",
        messageId: null,
        activityId: "activity-existing",
        dealId: "deal-existing",
      });
      expect(tx.crmContact.create).not.toHaveBeenCalled();
      expect(tx.crmContact.update).not.toHaveBeenCalled();
      expect(tx.crmConversation.create).not.toHaveBeenCalled();
      expect(tx.crmActivity.create).not.toHaveBeenCalled();
      expect(tx.crmDeal.create).not.toHaveBeenCalled();
      expect(appendEvents).not.toHaveBeenCalled();
    });

    it("rejects invalid email and missing consent before writing", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { captureCrmInquiry } = await import("./crm");

      await expect(captureCrmInquiry(inquiryInput({
        email: "not-an-email",
      }) as any)).rejects.toThrow("Valid email is required.");
      await expect(captureCrmInquiry(inquiryInput({
        consentToContact: false,
      }) as any)).rejects.toThrow("Consent to contact is required.");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects a matching contact whose account becomes archived before creating inquiry children", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { captureCrmInquiry } = await import("./crm");
      const tx = inquiryTx({
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null }),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
        },
      });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(captureCrmInquiry(inquiryInput())).rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
      for (const delegate of [tx.crmAccount, tx.crmContact, tx.crmConversation, tx.crmActivity, tx.crmDeal]) {
        expect(delegate.create).not.toHaveBeenCalled();
      }
    });

    it("retries contact account-link drift and creates no inquiry children after the bounded conflict", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { appendEvents } = await import("./events");
      const { captureCrmInquiry } = await import("./crm");
      const driftTx = (beforeAccountId: string, afterAccountId: string) => {
        const tx = inquiryTx();
        tx.crmContact.findUnique
          .mockResolvedValueOnce({ id: "contact-1", workspaceId: "ws-1", accountId: beforeAccountId, archivedAt: null })
          .mockResolvedValueOnce({ id: "contact-1", workspaceId: "ws-1", accountId: afterAccountId, archivedAt: null });
        return tx;
      };
      const first = driftTx("account-1", "account-2");
      const second = driftTx("account-2", "account-3");
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce((async (fn: any) => fn(first)) as any)
        .mockImplementationOnce((async (fn: any) => fn(second)) as any);

      await expect(captureCrmInquiry(inquiryInput())).rejects.toMatchObject({ code: "CRM_LINK_CLOSURE_CHANGED" });

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      for (const tx of [first, second]) {
        expect(tx.crmAccount.create).not.toHaveBeenCalled();
        expect(tx.crmContact.create).not.toHaveBeenCalled();
        expect(tx.crmContact.update).not.toHaveBeenCalled();
        expect(tx.crmConversation.create).not.toHaveBeenCalled();
        expect(tx.crmActivity.create).not.toHaveBeenCalled();
        expect(tx.crmDeal.create).not.toHaveBeenCalled();
      }
      expect(appendEvents).not.toHaveBeenCalled();
    });
    it("accepts connector-style sources through the same service", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { captureCrmInquiry } = await import("./crm");
      const tx = inquiryTx({
        crmAccount: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Meridian Works",
            slug: "meridian-works",
            domain: "meridian.example",
            tags: ["source:salesforce_connector", "persona:partner"],
          }),
          update: vi.fn(),
        },
        crmContact: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            email: "ava@meridian.example",
            accountId: "account-1",
            tags: ["source:salesforce_connector", "persona:partner"],
          }),
          update: vi.fn(),
        },
      });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await captureCrmInquiry(inquiryInput({
        source: "salesforce_connector",
        sourceExternalId: "lead-789",
        persona: "PARTNER",
      }));

      expect(tx.crmConversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "salesforce_connector",
          sourceExternalId: "lead-789",
        }),
      });
      expect(tx.crmContact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "salesforce_connector",
          tags: ["source:salesforce_connector", "persona:partner"],
        }),
      });
    });
  });

  describe("account foundation", () => {
    it("creates accounts with normalized relationship type, lifecycle stage, and slug", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createCrmAccount } = await import("./crm");

      const tx = {
        crmAccount: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Acme Corp",
            slug: "acme-com",
            domain: "acme.com",
            relationshipType: "CLIENT_PARTNER",
            lifecycleStage: "PILOT",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await createCrmAccount(dummyActor, {
        workspaceId: "ws-1",
        name: "Acme Corp",
        domain: "https://www.acme.com/path",
        relationshipType: "client partner",
        lifecycleStage: "pilot",
      });

      expect(tx.crmAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          name: "Acme Corp",
          slug: "acme-com",
          domain: "acme.com",
          relationshipType: "CLIENT_PARTNER",
          lifecycleStage: "PILOT",
        }),
      });
      expect(result.relationshipType).toBe("CLIENT_PARTNER");
    });

    it("lists accounts with relationship and lifecycle array filters", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { listCrmAccounts } = await import("./crm");

      vi.mocked(prisma.crmAccount.findMany).mockResolvedValue([
        { id: "account-1", workspaceId: "ws-1", relationshipType: "CLIENT", lifecycleStage: "ACTIVE" },
      ] as any);
      vi.mocked(prisma.crmAccount.count).mockResolvedValue(1);

      const result = await listCrmAccounts(dummyActor, "ws-1", {
        relationshipTypes: ["client", "partner"],
        lifecycleStages: ["active", "pilot"],
        take: 10,
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(prisma.crmAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          relationshipType: { in: ["CLIENT", "PARTNER"] },
          lifecycleStage: { in: ["ACTIVE", "PILOT"] },
        }),
        take: 10,
      }));
      expect(result.total).toBe(1);
    });

    it("keeps related counts visible when listing archived accounts for recovery", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listCrmAccounts } = await import("./crm");
      vi.mocked(prisma.crmAccount.findMany).mockResolvedValue([]);
      vi.mocked(prisma.crmAccount.count).mockResolvedValue(0);
      await listCrmAccounts(dummyActor, "ws-1", { archiveFilter: "archived" });
      const counts = (vi.mocked(prisma.crmAccount.findMany).mock.calls.at(-1)?.[0] as any).include._count.select;
      for (const relation of ["contacts", "deals", "activities"]) expect(counts[relation].where).toEqual({ archivedAt: null });
      expect(counts.crmConversations.where).toEqual({});
    });
    it("hides a direct conversation read when any linked CRM parent is archived", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { getCrmConversation } = await import("./crm");
      vi.mocked(prisma.crmConversation.findFirst).mockResolvedValue(null);
      await expect(getCrmConversation(dummyActor, { workspaceId: "ws-1", conversationId: "conversation-1" }))
        .rejects.toThrow("Conversation not found.");
      expect(prisma.crmConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", AND: expect.any(Array) }),
      }));
    });
    it("archives accounts through the shared archive system without cascading to linked CRM records", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { archiveCrmAccount } = await import("./crm");

      const result = await archiveCrmAccount(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(dummyActor, {
        workspaceId: "ws-1",
        entityType: "CrmAccount",
        entityId: "account-1",
        reason: "Archived from CRM account archive action.",
      });
      expect(prisma.crmContact.updateMany).not.toHaveBeenCalled();
      expect(prisma.crmDeal.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "account-1" });
    });

    it("links a new contact to an inferred account", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createContact } = await import("./crm");

      const tx = {
        crmAccount: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            archivedAt: null,
          }),
        },
        crmContact: {
          create: vi.fn().mockResolvedValue({
            id: "contact-1",
            email: "founder@acme.com",
            accountId: "account-1",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await createContact(dummyActor, {
        workspaceId: "ws-1",
        email: "Founder@Acme.com",
        company: "Acme Corp",
      });

      expect(tx.crmAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          name: "Acme Corp",
          slug: "acme-corp",
          domain: "acme.com",
        }),
      });
      expect(tx.crmContact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: "account-1",
          email: "founder@acme.com",
        }),
      });
    });

    it("does not use free email domains as inferred account domains", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createContact } = await import("./crm");

      const tx = {
        crmAccount: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            archivedAt: null,
          }),
        },
        crmContact: {
          create: vi.fn().mockResolvedValue({
            id: "contact-1",
            email: "founder@gmail.com",
            accountId: "account-1",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await createContact(dummyActor, {
        workspaceId: "ws-1",
        email: "founder@gmail.com",
        company: "Acme Corp",
      });

      expect(tx.crmAccount.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: "ws-1",
          archivedAt: null,
          OR: [{ slug: "acme-corp" }],
        },
      });
      expect(tx.crmAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Acme Corp",
          slug: "acme-corp",
          domain: null,
        }),
      });
    });

    it("locks a contact closure before updating its account link", async () => {
      const { prisma } = await import("@corgtex/shared"), { updateContact } = await import("./crm");
      const update = vi.fn().mockResolvedValue({ id: "contact-1", email: "buyer@example.test", accountId: "new-account" });
      const tx = { crmContact: { findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1",
        accountId: "old-account", archivedAt: null }), findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: "old-account" }]),
        findFirst: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "old-account", archivedAt: null }), update },
        crmActivity: { findMany: vi.fn().mockResolvedValue([{ id: "activity-1" }]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        crmAccount: { findUnique: vi.fn().mockResolvedValue({ id: "new-account", workspaceId: "ws-1", archivedAt: null }) },
        crmDeal: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, crmConversation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        crmProspectWorkspace: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, demoLead: { findFirst: vi.fn().mockResolvedValue(null) },
        auditLog: { create: vi.fn() } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await updateContact(dummyActor, { workspaceId: "ws-1", contactId: "contact-1", accountId: "new-account" });
      expect(lockWorkspaceArchiveArtifact.mock.calls.map(([, type, id]) => [type, id])).toEqual([
        ["CrmActivity", "activity-1"], ["CrmContact", "contact-1"], ["CrmAccount", "new-account"], ["CrmAccount", "old-account"]]);
      expect(lockWorkspaceArchiveArtifact.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    });

    it("retries account-link synchronization after an under-lock activity rescan changes", async () => {
      const { prisma } = await import("@corgtex/shared"), { updateContact } = await import("./crm");
      const activity = (id: string) => ({ id, accountId: null, contactId: "contact-1", dealId: null });
      const update = vi.fn().mockResolvedValue({ id: "contact-1", email: "buyer@example.test", accountId: "account-1" });
      const tx = { crmContact: { findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: null,
          archivedAt: null }), findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: null }]),
          findFirst: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1" }), update },
        crmActivity: { findMany: vi.fn()
          .mockResolvedValueOnce([activity("activity-1")]).mockResolvedValueOnce([activity("activity-1")])
          .mockResolvedValueOnce([activity("activity-1"), activity("activity-2")])
          .mockResolvedValueOnce([activity("activity-1"), activity("activity-2")])
          .mockResolvedValueOnce([activity("activity-1"), activity("activity-2")])
          .mockResolvedValueOnce([activity("activity-1"), activity("activity-2")]), updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
        crmAccount: { findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null }) },
        crmDeal: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        crmConversation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        crmProspectWorkspace: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        demoLead: { findFirst: vi.fn().mockResolvedValue(null) }, auditLog: { create: vi.fn() } };
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce((async (fn: any) => fn(tx)) as any)
        .mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await updateContact(dummyActor, { workspaceId: "ws-1", contactId: "contact-1", accountId: "account-1" });
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("rejects contact links to accounts from another workspace", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createContact } = await import("./crm");

      const tx = {
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "account-other",
            workspaceId: "ws-other",
            archivedAt: null,
          }),
        },
        crmContact: {
          create: vi.fn(),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(createContact(dummyActor, {
        workspaceId: "ws-1",
        email: "founder@acme.com",
        accountId: "account-other",
      })).rejects.toThrow();

      expect(tx.crmContact.create).not.toHaveBeenCalled();
    });

    it("converts an account to an active client without customer lifecycle writes", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { convertCrmAccountToClient } = await import("./crm");

      const tx = {
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            relationshipType: "PROSPECT",
            lifecycleStage: "PILOT",
            archivedAt: null,
          }),
          update: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            relationshipType: "CLIENT",
            lifecycleStage: "ACTIVE",
          }),
        },
        customerAccount: { upsert: vi.fn() },
        customerDeployment: { upsert: vi.fn() },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await convertCrmAccountToClient(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
      });

      expect(tx.crmAccount.update).toHaveBeenCalledWith({
        where: { id: "account-1" },
        data: {
          relationshipType: "CLIENT",
          lifecycleStage: "ACTIVE",
        },
      });
      expect(result).toMatchObject({ relationshipType: "CLIENT", lifecycleStage: "ACTIVE" });
      expect(tx.customerAccount.upsert).not.toHaveBeenCalled();
      expect(tx.customerDeployment.upsert).not.toHaveBeenCalled();
    });

    it("inherits the contact account when creating a deal", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createDeal } = await import("./crm");

      const tx = {
        crmAccount: { findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null }) },
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            archivedAt: null,
          }),
          findFirst: vi.fn().mockResolvedValue({
            id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]),
        },
        crmDeal: {
          create: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            title: "Pilot",
            stage: "LEAD",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
          }),
        },
        crmDealStageTransition: {
          create: vi.fn().mockResolvedValue({ id: "transition-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await createDeal(dummyActor, {
        workspaceId: "ws-1",
        contactId: "contact-1",
        title: "Pilot",
      });

      expect(tx.crmDeal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: "account-1",
          contactId: "contact-1",
          title: "Pilot",
        }),
      });
      expect(tx.crmDealStageTransition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          dealId: "deal-1",
          fromStage: null,
          toStage: "LEAD",
          actorUserId: "u-1",
        }),
      });

      tx.crmAccount.findUnique.mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: new Date() });
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(createDeal(dummyActor, {
        workspaceId: "ws-1", contactId: "contact-1", title: "Hidden deal",
      })).rejects.toThrow("Account not found.");
    });

    it("backfills accounts and related CRM records idempotently", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { backfillCrmAccountsForWorkspace } = await import("./crm");

      vi.mocked(prisma.crmContact.findMany).mockResolvedValueOnce([{ id: "contact-1", email: "founder@acme.com",
        company: "Acme Corp", source: "import" }] as any);

      const tx = {
        crmAccount: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Acme Corp",
            slug: "acme-corp",
            domain: "acme.com",
          }),
        },
        crmDeal: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: null }]),
          findFirst: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1", account: { archivedAt: null } }),
          update: vi.fn().mockResolvedValue({ id: "contact-1", accountId: "account-1" }) },
        crmActivity: {
          findMany: vi.fn().mockResolvedValue([{ id: "activity-1" }, { id: "activity-2" }, { id: "activity-3" }]),
          updateMany: vi.fn().mockResolvedValue({ count: 3 }),
        },
        crmConversation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        crmProspectWorkspace: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        demoLead: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await backfillCrmAccountsForWorkspace(dummyActor, {
        workspaceId: "ws-1",
      });

      expect(result).toEqual(expect.objectContaining({
        scanned: 1,
        accountsCreated: 1,
        contactsLinked: 1,
        dealsLinked: 2,
        activitiesLinked: 3,
        conversationsLinked: 1,
      }));
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledTimes(5);
      expect(lockWorkspaceArchiveArtifact.mock.calls.map(([, type, id]) => [type, id])).toEqual([
        ["CrmActivity", "activity-1"], ["CrmActivity", "activity-2"], ["CrmActivity", "activity-3"],
        ["CrmContact", "contact-1"], ["CrmAccount", expect.any(String)],
      ]);
      expect(tx.crmContact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
        accountId: "account-1", account: { archivedAt: null },
      }) }));
      expect(tx.crmActivity.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ archivedAt: null }),
      }));
      expect(tx.crmContact.update).toHaveBeenCalledWith({
        where: { id: "contact-1" },
        data: { accountId: "account-1" },
      });
      expect(lockWorkspaceArchiveArtifact.mock.invocationCallOrder[0]).toBeLessThan(tx.crmContact.update.mock.invocationCallOrder[0]!);

      vi.mocked(prisma.crmContact.findMany).mockResolvedValueOnce([] as any);

      await expect(backfillCrmAccountsForWorkspace(dummyActor, {
        workspaceId: "ws-1",
      })).resolves.toEqual(expect.objectContaining({
        scanned: 0,
        accountsCreated: 0,
        contactsLinked: 0,
      }));
    });

    it("lists CRM activities with account context through the workspace guard", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { listCrmActivities } = await import("./crm");

      vi.mocked(prisma.crmActivity.findMany).mockResolvedValue([
        { id: "activity-1", workspaceId: "ws-1", accountId: "account-1", title: "Follow-up" },
      ] as any);
      vi.mocked(prisma.crmActivity.count).mockResolvedValue(1);

      const result = await listCrmActivities(dummyActor, "ws-1", {
        accountId: "account-1",
        take: 10,
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(prisma.crmActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", accountId: "account-1" }),
        take: 10,
      }));
      expect(result.total).toBe(1);
    });

    it("lists open due CRM tasks with due and owner filters", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { listCrmActivities } = await import("./crm");

      vi.mocked(prisma.crmActivity.findMany).mockResolvedValue([]);
      vi.mocked(prisma.crmActivity.count).mockResolvedValue(0);

      const dueFrom = new Date("2026-06-18T00:00:00.000Z");
      const dueTo = new Date("2026-06-25T00:00:00.000Z");
      await listCrmActivities(dummyActor, "ws-1", {
        types: ["TASK", "EMAIL"] as any,
        ownerUserId: "u-1",
        completion: "open",
        dueFrom,
        dueTo,
        sort: "due",
      });

      expect(prisma.crmActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          type: { in: ["TASK", "EMAIL"] },
          ownerUserId: "u-1",
          completedAt: null,
          dueAt: { gte: dueFrom, lte: dueTo },
        }),
        orderBy: [
          { dueAt: { sort: "asc", nulls: "last" } },
          { createdAt: "desc" },
        ],
      }));
    });

    it("shares nullable-safe active-parent predicates across relationship lists and counts", async () => {
      const { prisma } = await import("@corgtex/shared");
      const crm = await import("./crm");
      const cases: [Function, any][] = [[crm.listContacts, prisma.crmContact], [crm.listDeals, prisma.crmDeal], [crm.listCrmActivities, prisma.crmActivity],
        [crm.listCommunicationSuggestions, prisma.crmCommunicationSuggestion], [crm.listCrmConversations, prisma.crmConversation],
        [crm.listCrmProspectWorkspaces, prisma.crmProspectWorkspace]];
      for (const [list, delegate] of cases) {
        vi.mocked(delegate.findMany).mockResolvedValue([] as never);
        vi.mocked(delegate.count).mockResolvedValue(0);
        await list(dummyActor, "ws-1");
        expect(delegate.count).toHaveBeenCalledWith({ where: vi.mocked(delegate.findMany).mock.calls[0]![0]!.where });
      }
      await crm.listContacts(dummyActor, "ws-1", { archiveFilter: "archived" });
      const recoveryCounts = (vi.mocked(prisma.crmContact.findMany).mock.calls[1]![0] as any).include._count.select;
      for (const relation of ["deals", "activities"]) expect(recoveryCounts[relation].where).toEqual({ archivedAt: null });
      const activityWhere = vi.mocked(prisma.crmActivity.findMany).mock.calls[0]![0]!.where!;
      expect(activityWhere).toMatchObject({ archivedAt: null,
        AND: expect.arrayContaining([{ OR: [{ accountId: null }, { account: { archivedAt: null } }] }]) });
      expect(activityWhere.AND).toEqual(expect.arrayContaining([
        { OR: [{ dealId: null }, { deal: { archivedAt: null, contact: { archivedAt: null,
          OR: [{ accountId: null }, { account: { archivedAt: null } }] },
          OR: [{ accountId: null }, { account: { archivedAt: null } }] } }] },
      ]));
      await crm.listCrmActivities(dummyActor, "ws-1", { archiveFilter: "archived" });
      await crm.listCrmActivities(dummyActor, "ws-1", { archiveFilter: "all" });
      expect(vi.mocked(prisma.crmActivity.findMany).mock.calls[1]![0]!.where).toEqual({ workspaceId: "ws-1", archivedAt: { not: null } });
      expect(vi.mocked(prisma.crmActivity.findMany).mock.calls[2]![0]!.where).toEqual({ workspaceId: "ws-1" });
    });
    it("archives named CRM records and fails closed on archived activity writes", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { archiveCrmActivity, archiveCrmDeal, completeActivity, updateActivity } = await import("./crm");
      await archiveCrmDeal(dummyActor, { workspaceId: "ws-1", dealId: "deal-1" });
      await archiveCrmActivity(dummyActor, { workspaceId: "ws-1", activityId: "activity-1" });
      expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(dummyActor, expect.objectContaining({ entityType: "CrmDeal" }));
      expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(dummyActor, expect.objectContaining({ entityType: "CrmActivity" }));
      const updates = vi.fn();
      const activity = { id: "activity-1", workspaceId: "ws-1", archivedAt: new Date(), completedAt: null };
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce((async (fn: any) => fn({ crmActivity: { findUnique: vi.fn().mockResolvedValue(activity), update: updates } })) as any)
        .mockImplementationOnce((async (fn: any) => fn({ crmActivity: { findUnique: vi.fn().mockResolvedValue({ ...activity, archivedAt: null }),
          findMany: vi.fn().mockResolvedValue([{ accountId: null, contactId: null, dealId: null }]),
          findFirst: vi.fn().mockResolvedValue(null), update: updates } })) as any);
      await expect(updateActivity(dummyActor, { workspaceId: "ws-1", activityId: "activity-1", title: "Changed" })).rejects.toThrow("Activity not found");
      await expect(completeActivity(dummyActor, { workspaceId: "ws-1", activityId: "activity-1" })).rejects.toThrow("Activity not found");
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledTimes(1);
      expect(updates).not.toHaveBeenCalled();
    });
    it("locks activity relinks in canonical type and lexical id order", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateActivity } = await import("./crm");
      const activity = { id: "activity-1", workspaceId: "ws-1", archivedAt: null, accountId: "z-account", contactId: "z-contact", dealId: "z-deal" };
      const tx = { crmActivity: { findUnique: vi.fn().mockResolvedValue(activity), findFirst: vi.fn().mockResolvedValue(activity),
          findMany: vi.fn().mockResolvedValue([{ accountId: "z-account", contactId: "z-contact", dealId: "z-deal" }]),
          update: vi.fn().mockResolvedValue(activity) },
        crmContact: { findUnique: vi.fn().mockResolvedValue({ id: "a-contact", workspaceId: "ws-1", archivedAt: null, accountId: "a-account" }),
          findFirst: vi.fn().mockResolvedValue({ id: "a-contact", workspaceId: "ws-1", archivedAt: null, accountId: "a-account" }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "a-account" }, { accountId: "z-account" }]) },
        crmDeal: { findUnique: vi.fn().mockResolvedValue({ id: "a-deal", workspaceId: "ws-1", archivedAt: null, accountId: "a-account" }),
          findFirst: vi.fn().mockResolvedValue({ id: "a-deal", workspaceId: "ws-1", archivedAt: null, accountId: "a-account" }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "a-account", contactId: "a-contact" },
            { accountId: "z-account", contactId: "z-contact" }]) },
        crmAccount: { findUnique: vi.fn().mockResolvedValue({ id: "a-account", workspaceId: "ws-1", archivedAt: null }) },
        auditLog: { create: vi.fn() } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await updateActivity(dummyActor, { workspaceId: "ws-1", activityId: "activity-1", accountId: "a-account", contactId: "a-contact", dealId: "a-deal" });
      expect(lockWorkspaceArchiveArtifact.mock.calls.map(([, type, id]) => [type, id])).toEqual([
        ["CrmActivity", "activity-1"], ["CrmDeal", "a-deal"], ["CrmDeal", "z-deal"], ["CrmContact", "a-contact"],
        ["CrmContact", "z-contact"], ["CrmAccount", "a-account"], ["CrmAccount", "z-account"]]);
    });
    it("locks the full current and replacement suggestion closure canonically", async () => {
      const { lockCrmLinkClosure } = await import("./crm-archive-guards");
      const tx = {
        crmActivity: { findMany: vi.fn().mockResolvedValue([
          { accountId: "z-account", contactId: "z-contact", dealId: "z-deal" },
          { accountId: "a-account", contactId: "a-contact", dealId: "a-deal" },
        ]) },
        crmDeal: { findMany: vi.fn().mockResolvedValue([
          { accountId: "z-account", contactId: "z-contact" }, { accountId: "a-account", contactId: "a-contact" },
        ]) },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ accountId: "z-account" }, { accountId: "a-account" }]) },
      };
      await lockCrmLinkClosure(tx as any, "ws-1", { activityId: "z-activity" }, { activityId: "a-activity" });
      expect(lockWorkspaceArchiveArtifact.mock.calls.map(([, type, id]) => [type, id])).toEqual([
        ["CrmActivity", "a-activity"], ["CrmActivity", "z-activity"], ["CrmDeal", "a-deal"], ["CrmDeal", "z-deal"],
        ["CrmContact", "a-contact"], ["CrmContact", "z-contact"], ["CrmAccount", "a-account"], ["CrmAccount", "z-account"],
      ]);
    });
    it("omits the welcome activity when the converted contact changes account under lock", async () => {
      const { prisma } = await import("@corgtex/shared"), { recordDemoWelcomeCrmActivity } = await import("./crm");
      const upsert = vi.fn(), tx = {
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1" }),
          findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: "account-1" }]),
          findFirst: vi.fn().mockResolvedValue({ id: "contact-1", accountId: "account-2" }),
        }, crmAccount: { findMany: vi.fn().mockResolvedValue([{ id: "account-1", archivedAt: null }]) },
        crmDeal: { findMany: vi.fn().mockResolvedValue([]) }, crmActivity: { findMany: vi.fn().mockResolvedValue([]), upsert },
        demoLead: { findFirst: vi.fn().mockResolvedValue({ id: "lead-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(recordDemoWelcomeCrmActivity({ workspaceId: "ws-1", demoLeadId: "lead-1",
        expectedContactId: "contact-1" })).resolves.toEqual({ created: false });
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledWith(tx, "CrmContact", "contact-1");
      expect(upsert).not.toHaveBeenCalled();
    });
    it("idempotently recovers a captured lead welcome activity by canonical email", async () => {
      const { prisma } = await import("@corgtex/shared"), { recordDemoWelcomeCrmActivity } = await import("./crm");
      const upsert = vi.fn().mockResolvedValue({ id: "activity-1" });
      const tx = {
        demoLead: { findFirst: vi.fn(({ select }) => select?.email
          ? { email: "lead@example.com", convertedContactId: null } : { id: "lead-1" }) },
        crmContact: { findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: null }),
          findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: null }]),
          findFirst: vi.fn().mockResolvedValue({ id: "contact-1", accountId: null }) },
        crmDeal: { findMany: vi.fn().mockResolvedValue([]) },
        crmActivity: { findMany: vi.fn().mockResolvedValue([]), upsert },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      const params = { workspaceId: "ws-1", demoLeadId: "lead-1", expectedContactId: null };
      await expect(recordDemoWelcomeCrmActivity(params)).resolves.toEqual({ created: true, activityId: "activity-1" });
      await recordDemoWelcomeCrmActivity(params);
      expect(upsert).toHaveBeenCalledTimes(2);
    });
    it("creates a due reminder task with validated owner and source metadata", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createActivity } = await import("./crm");

      const tx = {
        member: {
          findFirst: vi.fn().mockResolvedValue({ id: "member-1" }),
        },
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null }),
        },
        crmContact: {
          findUnique: vi.fn(),
        },
        crmDeal: {
          findUnique: vi.fn(),
        },
        crmActivity: {
          create: vi.fn().mockResolvedValue({ id: "activity-1" }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const dueAt = new Date("2026-06-20T00:00:00.000Z");
      await createActivity(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        title: "Send pilot recap",
        type: "TASK" as any,
        ownerUserId: "u-1",
        source: "agent_suggestion",
        dueAt,
      });

      expect(tx.member.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", userId: "u-1", isActive: true },
        select: { id: true },
      });
      expect(tx.crmActivity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          accountId: "account-1",
          type: "TASK",
          title: "Send pilot recap",
          ownerUserId: "u-1",
          source: "agent_suggestion",
          dueAt,
          completedAt: null,
        }),
      });
    });

    it("rejects reminder owners outside the workspace", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createActivity } = await import("./crm");

      const tx = {
        member: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(createActivity(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        title: "Send pilot recap",
        type: "TASK" as any,
        ownerUserId: "u-other",
      })).rejects.toThrow("Activity owner not found.");
    });
    it("rejects activity links when the deal contact is archived", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createActivity } = await import("./crm");
      const create = vi.fn();
      const tx = {
        member: { findFirst: vi.fn() },
        crmDeal: { findMany: vi.fn().mockResolvedValue([{ accountId: "account-1", contactId: "contact-1" }]),
          findFirst: vi.fn().mockResolvedValue(null) },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]) },
        crmActivity: { create },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(createActivity(dummyActor, { workspaceId: "ws-1", dealId: "deal-1", title: "Blocked" }))
        .rejects.toThrow("Deal not found.");
      expect(create).not.toHaveBeenCalled();
    });

    it("updates reminder due date and owner after validating workspace links", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateActivity } = await import("./crm");

      const dueAt = new Date("2026-06-22T00:00:00.000Z");
      const tx = {
        crmActivity: {
          findUnique: vi.fn().mockResolvedValue({
            id: "activity-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: null,
            dealId: null,
            source: "manual",
            completedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "account-1", contactId: null, dealId: null }]),
          update: vi.fn().mockResolvedValue({ id: "activity-1" }),
        },
        member: {
          findFirst: vi.fn().mockResolvedValue({ id: "member-1" }),
        },
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await updateActivity(dummyActor, {
        workspaceId: "ws-1",
        activityId: "activity-1",
        title: "Send revised recap",
        ownerUserId: "u-1",
        dueAt,
      });

      expect(tx.crmActivity.update).toHaveBeenCalledWith({
        where: { id: "activity-1" },
        data: {
          title: "Send revised recap",
          dueAt,
          ownerUserId: "u-1",
        },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "crm.activity.updated",
          meta: { fields: ["title", "dueAt", "ownerUserId"] },
        }),
      }));
    });

    it("completes an open reminder and records the completing user", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { completeActivity } = await import("./crm");

      const completedAt = new Date("2026-06-18T12:00:00.000Z");
      const tx = {
        crmActivity: {
          findUnique: vi.fn().mockResolvedValue({
            id: "activity-1",
            workspaceId: "ws-1",
            source: "manual",
            completedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([{ accountId: null, contactId: null, dealId: null }]),
          update: vi.fn().mockResolvedValue({ id: "activity-1", completedAt }),
        },
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await completeActivity(dummyActor, {
        workspaceId: "ws-1",
        activityId: "activity-1",
        completedAt,
      });

      expect(tx.crmActivity.update).toHaveBeenCalledWith({
        where: { id: "activity-1" },
        data: {
          completedAt,
          completedByUserId: "u-1",
        },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "crm.activity.completed",
          entityId: "activity-1",
        }),
      }));
    });

    it("rejects completion for activities in another workspace", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { completeActivity } = await import("./crm");

      const tx = {
        crmActivity: {
          findUnique: vi.fn().mockResolvedValue({
            id: "activity-1",
            workspaceId: "ws-other",
            completedAt: null,
          }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(completeActivity(dummyActor, {
        workspaceId: "ws-1",
        activityId: "activity-1",
      })).rejects.toThrow("Activity not found.");
    });

    it("lists CRM prospect workspaces with account context through the workspace guard", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { listCrmProspectWorkspaces } = await import("./crm");

      vi.mocked(prisma.crmProspectWorkspace.findMany).mockResolvedValue([
        { id: "pw-1", crmWorkspaceId: "ws-1", accountId: "account-1", status: "ACTIVE" },
      ] as any);
      vi.mocked(prisma.crmProspectWorkspace.count).mockResolvedValue(1);

      const result = await listCrmProspectWorkspaces(dummyActor, "ws-1", {
        accountId: "account-1",
        status: "ACTIVE",
        take: 5,
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(prisma.crmProspectWorkspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ crmWorkspaceId: "ws-1", accountId: "account-1", status: "ACTIVE" }),
        take: 5,
      }));
      expect(result.total).toBe(1);
    });
  });

  describe("relationship lists", () => {
    it("archives contacts through the shared archive system", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      const { archiveContact } = await import("./crm");

      const result = await archiveContact(dummyActor, {
        workspaceId: "ws-1",
        contactId: "contact-1",
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(dummyActor, {
        workspaceId: "ws-1",
        entityType: "CrmContact",
        entityId: "contact-1",
        reason: "Archived from CRM contact archive action.",
      });
      expect(result).toEqual({ id: "contact-1" });
    });

    it("filters contacts and deals by linked relationship ids", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { listContacts, listDeals } = await import("./crm");

      vi.mocked(prisma.crmContact.findMany).mockResolvedValue([
        { id: "contact-1", workspaceId: "ws-1", accountId: "account-1", email: "buyer@example.test" },
      ] as any);
      vi.mocked(prisma.crmContact.count).mockResolvedValue(1);
      vi.mocked(prisma.crmDeal.findMany).mockResolvedValue([
        { id: "deal-1", workspaceId: "ws-1", accountId: "account-1", contactId: "contact-1", stage: "QUALIFIED" },
      ] as any);
      vi.mocked(prisma.crmDeal.count).mockResolvedValue(1);

      const contacts = await listContacts(dummyActor, "ws-1", {
        accountId: "account-1",
        query: "buyer",
        take: 5,
      });
      const deals = await listDeals(dummyActor, "ws-1", {
        accountId: "account-1",
        contactId: "contact-1",
        stages: ["QUALIFIED", "PROPOSAL"] as any,
        take: 7,
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(prisma.crmContact.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          accountId: "account-1",
          OR: expect.any(Array),
        }),
        take: 5,
      }));
      expect(prisma.crmDeal.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          accountId: "account-1",
          contactId: "contact-1",
          stage: { in: ["QUALIFIED", "PROPOSAL"] },
        }),
        take: 7,
      }));
      expect(contacts.total).toBe(1);
      expect(deals.total).toBe(1);
    });
  });

  describe("communication suggestions", () => {
    it("lists suggested communications with workspace and owner filters", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireWorkspaceMembership } = await import("./auth");
      const { listCommunicationSuggestions } = await import("./crm");

      vi.mocked(prisma.crmCommunicationSuggestion.findMany).mockResolvedValue([
        { id: "suggestion-1", workspaceId: "ws-1", status: "REQUESTED", title: "Send pilot recap" },
      ] as any);
      vi.mocked(prisma.crmCommunicationSuggestion.count).mockResolvedValue(1);

      const result = await listCommunicationSuggestions(dummyActor, "ws-1", {
        statuses: ["requested", "sent"],
        ownerUserId: "u-1",
        take: 10,
      });

      expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor: dummyActor, workspaceId: "ws-1" });
      expect(prisma.crmCommunicationSuggestion.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", ownerUserId: "u-1", status: { in: ["REQUESTED", "SENT"] } }),
        take: 10,
      }));
      expect(result.total).toBe(1);
    });

    it("creates a suggestion linked to CRM context and defaults the recipient from the contact", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createCommunicationSuggestion } = await import("./crm");

      const tx = {
        member: { findFirst: vi.fn().mockResolvedValue({ id: "member-1" }) },
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null }),
        },
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            email: "ava@meridian.example",
            name: "Ava Chen",
            archivedAt: null,
          }),
          findFirst: vi.fn().mockResolvedValue({
            id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]),
        },
        crmDeal: { findUnique: vi.fn() },
        crmActivity: { findUnique: vi.fn() },
        crmCommunicationSuggestion: {
          create: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "SUGGESTED",
            channel: "EMAIL",
            recipientEmail: "ava@meridian.example",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await createCommunicationSuggestion(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        contactId: "contact-1",
        ownerUserId: "u-1",
        title: "Send pilot recap",
        subject: "Pilot recap and next steps",
        bodyMd: "Thanks for joining the review. Here are the next steps.",
        source: "agent_suggestion",
      });

      expect(tx.member.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", userId: "u-1", isActive: true },
        select: { id: true },
      });
      expect(tx.crmCommunicationSuggestion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          accountId: "account-1",
          contactId: "contact-1",
          ownerUserId: "u-1",
          status: "SUGGESTED",
          channel: "EMAIL",
          recipientEmail: "ava@meridian.example",
          recipientName: "Ava Chen",
          source: "agent_suggestion",
        }),
        include: expect.any(Object),
      });
    });

    it("locks and rejects an archived activity when creating a suggestion", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createCommunicationSuggestion } = await import("./crm");
      const tx = { member: { findFirst: vi.fn() }, crmActivity: {
        findMany: vi.fn().mockResolvedValue([{ accountId: null, contactId: null, dealId: null }]),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ id: "activity-1", workspaceId: "ws-1", archivedAt: new Date() }),
      }, crmCommunicationSuggestion: { create: vi.fn() } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(createCommunicationSuggestion(dummyActor, { workspaceId: "ws-1", activityId: "activity-1",
        title: "Do not link", bodyMd: "Archived context" })).rejects.toThrow("Activity not found.");
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledWith(tx, "CrmActivity", "activity-1");
      expect(tx.crmCommunicationSuggestion.create).not.toHaveBeenCalled();
    });
    it("edits draft content without changing finalized suggestions", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateCommunicationSuggestion } = await import("./crm");

      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "FAILED",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: null,
            activityId: null,
          }),
          update: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "FAILED",
          }),
        },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]) },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await updateCommunicationSuggestion(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-1",
        title: "Revised pilot recap",
        bodyMd: "Revised copy for external execution.",
        recipientEmail: "ava@meridian.example",
      });

      expect(tx.crmCommunicationSuggestion.update).toHaveBeenCalledWith({
        where: { id: "suggestion-1" },
        data: {
          title: "Revised pilot recap",
          bodyMd: "Revised copy for external execution.",
          recipientEmail: "ava@meridian.example",
        },
        include: expect.any(Object),
      });

      const finalizedTx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({ id: "suggestion-2", workspaceId: "ws-1", status: "SENT" }),
          update: vi.fn(),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(finalizedTx)) as any);

      await expect(updateCommunicationSuggestion(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-2",
        title: "Do not edit",
      })).rejects.toThrow("Finalized suggestions cannot be edited.");
      expect(finalizedTx.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
    });

    it("requests external execution without sending email from Corgtex", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requestCommunicationSuggestionExecution } = await import("./crm");

      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "SUGGESTED",
          }),
          update: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "REQUESTED",
            externalRequestId: "exec-1",
          }),
        },
        crmActivity: { create: vi.fn() },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await requestCommunicationSuggestionExecution(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-1",
        externalRequestId: "exec-1",
      });

      expect(tx.crmCommunicationSuggestion.update).toHaveBeenCalledWith({
        where: { id: "suggestion-1" },
        data: expect.objectContaining({
          status: "REQUESTED",
          externalRequestId: "exec-1",
          requestedAt: expect.any(Date),
          sentAt: null,
          declinedAt: null,
          failedAt: null,
          failureReason: null,
        }),
        include: expect.any(Object),
      });
      expect(tx.crmActivity.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "crm.communication_suggestion.requested",
          meta: { note: "External execution request tracked; no email sent by Corgtex." },
        }),
      }));
    });

    it("marks externally sent suggestions as sent and records an email activity", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { markCommunicationSuggestionSent } = await import("./crm");

      const sentAt = new Date("2026-06-18T12:00:00.000Z");
      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            dealId: "deal-1",
            status: "REQUESTED",
            title: "Send pilot recap",
            subject: "Pilot recap and next steps",
            bodyMd: "Thanks for joining the review.",
          }),
          update: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "SENT",
            sentAt,
          }),
        },
        crmActivity: {
          create: vi.fn().mockResolvedValue({ id: "activity-1" }),
        },
        crmDeal: { findMany: vi.fn().mockResolvedValue([{ accountId: "account-1", contactId: "contact-1" }]) },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]) },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await markCommunicationSuggestionSent(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-1",
        sentAt,
      });

      expect(tx.crmCommunicationSuggestion.update).toHaveBeenCalledWith({
        where: { id: "suggestion-1" },
        data: {
          status: "SENT",
          sentAt,
          declinedAt: null,
          failedAt: null,
          failureReason: null,
        },
        include: expect.any(Object),
      });
      expect(tx.crmActivity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          accountId: "account-1",
          contactId: "contact-1",
          dealId: "deal-1",
          actorUserId: "u-1",
          type: "EMAIL",
          title: "Pilot recap and next steps",
          source: "communication_suggestion",
          createdAt: sentAt,
        }),
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "crm.communication_suggestion.sent",
          meta: { emailSentByCorgtex: false },
        }),
      }));
    });

    it("declines suggestions without deleting the draft", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { declineCommunicationSuggestion } = await import("./crm");

      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "SUGGESTED",
          }),
          update: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "DECLINED",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await declineCommunicationSuggestion(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-1",
      });

      expect(tx.crmCommunicationSuggestion.update).toHaveBeenCalledWith({
        where: { id: "suggestion-1" },
        data: expect.objectContaining({
          status: "DECLINED",
          declinedAt: expect.any(Date),
          failedAt: null,
          failureReason: null,
        }),
        include: expect.any(Object),
      });
    });

    it("retains failed execution results for later review", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { failCommunicationSuggestion } = await import("./crm");

      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "REQUESTED",
          }),
          update: vi.fn().mockResolvedValue({
            id: "suggestion-1",
            workspaceId: "ws-1",
            status: "FAILED",
            failureReason: "Mailbox authentication expired.",
          }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await failCommunicationSuggestion(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-1",
        failureReason: "Mailbox authentication expired.",
      });

      expect(tx.crmCommunicationSuggestion.update).toHaveBeenCalledWith({
        where: { id: "suggestion-1" },
        data: expect.objectContaining({
          status: "FAILED",
          failedAt: expect.any(Date),
          failureReason: "Mailbox authentication expired.",
        }),
        include: expect.any(Object),
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: "crm.communication_suggestion.failed",
          meta: { failureReason: "Mailbox authentication expired." },
        }),
      }));
    });

    it("rejects suggestion mutations across workspace boundaries", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requestCommunicationSuggestionExecution } = await import("./crm");

      const tx = {
        crmCommunicationSuggestion: {
          findUnique: vi.fn().mockResolvedValue({
            id: "suggestion-other",
            workspaceId: "ws-other",
            status: "SUGGESTED",
          }),
          update: vi.fn(),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(requestCommunicationSuggestionExecution(dummyActor, {
        workspaceId: "ws-1",
        suggestionId: "suggestion-other",
      })).rejects.toThrow("Communication suggestion not found.");
      expect(tx.crmCommunicationSuggestion.update).not.toHaveBeenCalled();
    });

    it("rejects mutations when a suggestion is hidden by an archived parent", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { markCommunicationSuggestionSent } = await import("./crm");
      const create = vi.fn();
      const tx = { crmCommunicationSuggestion: { findUnique: vi.fn().mockResolvedValue({
        id: "suggestion-1", workspaceId: "ws-1", accountId: "account-1" }), findFirst: vi.fn().mockResolvedValue(null) }, crmActivity: { create } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(markCommunicationSuggestionSent(dummyActor, { workspaceId: "ws-1", suggestionId: "suggestion-1" }))
        .rejects.toThrow("Communication suggestion not found.");
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("deal stage transitions", () => {
    it("rejects deals hidden by an archived account or contact", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");
      const update = vi.fn();
      const tx = {
        crmDeal: { findUnique: vi.fn().mockResolvedValue({ id: "deal-1", workspaceId: "ws-1", archivedAt: null,
          accountId: "account-1", contactId: "contact-1" }), findMany: vi.fn().mockResolvedValue([{
          id: "deal-1", accountId: "account-1", contactId: "contact-1",
        }]), findFirst: vi.fn().mockResolvedValue(null), update },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: "account-1" }]) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(updateDeal(dummyActor, { workspaceId: "ws-1", dealId: "deal-1", title: "Blocked" })).rejects.toThrow("Deal not found.");
      expect(tx.crmDeal.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ AND: expect.any(Array) }) });
      expect(update).not.toHaveBeenCalled();
    });
    it("locks the required contact account before rejecting a deal hidden by that archived transitive parent", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");
      const update = vi.fn();
      const tx = {
        crmDeal: {
          findUnique: vi.fn().mockResolvedValue({ id: "deal-1", workspaceId: "ws-1", archivedAt: null,
            accountId: "z-account", contactId: "contact-1" }),
          findMany: vi.fn().mockResolvedValue([{ id: "deal-1", accountId: "z-account", contactId: "contact-1" }]),
          findFirst: vi.fn().mockResolvedValue(null), update,
        },
        crmContact: { findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: "a-account" }]) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(updateDeal(dummyActor, { workspaceId: "ws-1", dealId: "deal-1", title: "Blocked" }))
        .rejects.toThrow("Deal not found.");

      expect(lockWorkspaceArchiveArtifact.mock.calls.map(([, type, id]) => [type, id])).toEqual([
        ["CrmDeal", "deal-1"],
        ["CrmContact", "contact-1"],
        ["CrmAccount", "a-account"],
        ["CrmAccount", "z-account"],
      ]);
      expect(update).not.toHaveBeenCalled();
    });
    it("records an initial stage transition when creating a deal", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createDeal } = await import("./crm");

      const tx = {
        crmAccount: { findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null }) },
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            archivedAt: null,
          }),
          findFirst: vi.fn().mockResolvedValue({
            id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]),
        },
        crmDeal: {
          create: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            contactId: "contact-1",
            title: "Expansion",
            stage: "PROPOSAL",
            createdAt: new Date("2026-06-11T00:00:00.000Z"),
          }),
        },
        crmDealStageTransition: {
          create: vi.fn().mockResolvedValue({ id: "transition-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await createDeal(dummyActor, {
        workspaceId: "ws-1",
        contactId: "contact-1",
        title: "Expansion",
        stage: "PROPOSAL" as any,
        valueCents: 0,
      });

      expect(tx.crmDeal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          stage: "PROPOSAL",
          valueCents: 0,
          closedAt: null,
        }),
      });
      expect(tx.crmDealStageTransition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          dealId: "deal-1",
          fromStage: null,
          toStage: "PROPOSAL",
          actorUserId: "u-1",
          createdAt: new Date("2026-06-11T00:00:00.000Z"),
        }),
      });
    });

    it("records one transition and closes the deal when stage changes to won", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");

      const tx = {
        crmDeal: {
          findUnique: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            stage: "NEGOTIATION",
            archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            stage: "CLOSED_WON",
          }),
        },
        crmDealStageTransition: {
          create: vi.fn().mockResolvedValue({ id: "transition-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await updateDeal(dummyActor, {
        workspaceId: "ws-1",
        dealId: "deal-1",
        stage: "CLOSED_WON" as any,
      });

      expect(tx.crmDeal.update).toHaveBeenCalledWith({
        where: { id: "deal-1" },
        data: {
          stage: "CLOSED_WON",
          closedAt: expect.any(Date),
        },
      });
      expect(tx.crmDealStageTransition.create).toHaveBeenCalledTimes(1);
      expect(tx.crmDealStageTransition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          dealId: "deal-1",
          fromStage: "NEGOTIATION",
          toStage: "CLOSED_WON",
          actorUserId: "u-1",
        }),
      });
    });

    it("clears closedAt when a deal returns to an open stage", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");

      const tx = {
        crmDeal: {
          findUnique: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            stage: "CLOSED_WON",
            archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            stage: "NEGOTIATION",
            closedAt: null,
          }),
        },
        crmDealStageTransition: {
          create: vi.fn().mockResolvedValue({ id: "transition-1" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await updateDeal(dummyActor, {
        workspaceId: "ws-1",
        dealId: "deal-1",
        stage: "NEGOTIATION" as any,
      });

      expect(tx.crmDeal.update).toHaveBeenCalledWith({
        where: { id: "deal-1" },
        data: {
          stage: "NEGOTIATION",
          closedAt: null,
        },
      });
      expect(tx.crmDealStageTransition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromStage: "CLOSED_WON",
          toStage: "NEGOTIATION",
        }),
      });
    });

    it("does not record a transition for no-op stage updates", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");

      const tx = {
        crmDeal: {
          findUnique: vi.fn().mockResolvedValue({
            id: "deal-1",
            workspaceId: "ws-1",
            stage: "PROPOSAL",
            archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
        crmDealStageTransition: {
          create: vi.fn(),
        },
        auditLog: { create: vi.fn() },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await updateDeal(dummyActor, {
        workspaceId: "ws-1",
        dealId: "deal-1",
        stage: "PROPOSAL" as any,
      });

      expect(result).toEqual(expect.objectContaining({ id: "deal-1" }));
      expect(tx.crmDeal.update).not.toHaveBeenCalled();
      expect(tx.crmDealStageTransition.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects stage updates for deals from another workspace", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { updateDeal } = await import("./crm");

      const tx = {
        crmDeal: {
          findUnique: vi.fn().mockResolvedValue({
            id: "deal-other",
            workspaceId: "ws-other",
            stage: "LEAD",
            archivedAt: null,
          }),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
        crmDealStageTransition: {
          create: vi.fn(),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(updateDeal(dummyActor, {
        workspaceId: "ws-1",
        dealId: "deal-other",
        stage: "QUALIFIED" as any,
      })).rejects.toThrow();

      expect(tx.crmDeal.update).not.toHaveBeenCalled();
      expect(tx.crmDealStageTransition.create).not.toHaveBeenCalled();
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
    it("excludes archived contacts from qualification relinking", async () => {
      const { prisma } = await import("@corgtex/shared"), { approveQualification } = await import("./crm");
      vi.mocked(prisma.crmQualification.findUnique).mockResolvedValue({ id: "qual-1", workspaceId: "ws-1", status: "PENDING_REVIEW", companyName: "Acme", website: "acme.com", demoLead: { id: "lead-1", email: "demo@acme.com" } } as any);
      const findMany = vi.fn().mockResolvedValue([]), updateMany = vi.fn(), tx = { crmQualification: { update: vi.fn() },
        crmAccount: { findFirst: vi.fn().mockResolvedValue({ id: "account-1", domain: "acme.com", tags: [] }),
          findUnique: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", archivedAt: null, tags: [] }),
          update: vi.fn().mockResolvedValue({ id: "account-1" }) },
        crmContact: { findMany, updateMany }, crmActivity: { findMany: vi.fn().mockResolvedValue([]) },
        crmConversation: { updateMany: vi.fn() }, crmProspectWorkspace: { updateMany: vi.fn() } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any); await approveQualification(dummyActor, { workspaceId: "ws-1", qualificationId: "qual-1" });
      for (const query of [findMany, updateMany]) expect(query).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ archivedAt: null }) }));
    });
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
    it("does not append inbound replies through archived CRM parents", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { syncEmailReplyToConversation } = await import("./crm");
      const create = vi.fn();
      const rawConversation = { id: "conv-1", workspaceId: "ws-1", accountId: "account-1", contactId: null, dealId: null };
      const tx = {
        demoLead: { findFirst: vi.fn().mockResolvedValue({ id: "lead-1", workspaceId: "ws-1" }) },
        crmConversation: { findFirst: vi.fn().mockResolvedValueOnce(rawConversation).mockResolvedValueOnce(null), create: vi.fn(), update: vi.fn() },
        crmContact: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
        crmConversationMessage: { create },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(syncEmailReplyToConversation({ fromEmail: "buyer@example.test", subject: "Reply", bodyText: "Interested" })).resolves.toBeNull();
      expect(tx.crmConversation.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({
        id: "conv-1", AND: expect.any(Array),
      }) }));
      expect(create).not.toHaveBeenCalled();
    });
    it("rechecks direct conversation parents after locking before inserting", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createConversationMessage } = await import("./crm");
      const create = vi.fn();
      const tx = { crmConversation: {
        findUnique: vi.fn().mockResolvedValue({ id: "conv-1", workspaceId: "ws-1", accountId: "account-1" }),
        findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(),
      }, crmConversationMessage: { create } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(createConversationMessage(dummyActor, { workspaceId: "ws-1", conversationId: "conv-1",
        bodyMd: "Blocked", senderType: "ADMIN" })).rejects.toThrow("Conversation not found.");
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledWith(tx, "CrmAccount", "account-1");
      expect(create).not.toHaveBeenCalled();
    });
  });

  // --- provisionProspectWorkspace ---
  describe("provisionProspectWorkspace", () => {
    it("creates a new workspace and links it to the demo lead", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { provisionProspectWorkspace } = await import("./crm");

      const result = await provisionProspectWorkspace(dummyActor, {
        demoLeadId: "lead-1",
        adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1",
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("does not register customer lifecycle records during ordinary prospect provisioning", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { provisionProspectWorkspace } = await import("./crm");

      const customerAccountUpsert = vi.fn();
      const customerDeploymentUpsert = vi.fn();
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(0),
        demoLead: { findUnique: vi.fn().mockResolvedValue({ id: "lead-1", email: "demo@acme.com", workspaceId: "ws-1" }) },
        crmContact: { findFirst: vi.fn().mockResolvedValue(null) },
        workspace: {
          create: vi.fn().mockResolvedValue({ id: "ws-new", name: "Demo Workspace", slug: "demo-123" }),
        },
        crmProspectWorkspace: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "pw-1", crmWorkspaceId: "ws-1", targetWorkspaceId: "ws-new" }),
        },
        customerAccount: {
          upsert: customerAccountUpsert,
        },
        customerDeployment: {
          upsert: customerDeploymentUpsert,
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await provisionProspectWorkspace(dummyActor, {
        demoLeadId: "lead-1",
        adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1",
      });

      expect(tx.crmProspectWorkspace.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          crmWorkspaceId: "ws-1",
          demoLeadId: "lead-1",
          targetWorkspaceId: "ws-new",
          status: "ACTIVE",
        }),
      });
      expect(customerAccountUpsert).not.toHaveBeenCalled();
      expect(customerDeploymentUpsert).not.toHaveBeenCalled();
    });

    it("returns existing workspace if already provisioned", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { provisionProspectWorkspace } = await import("./crm");

      const existing = { id: "pw-existing", crmWorkspaceId: "ws-1", demoLeadId: "lead-1" };
      const tx = { $executeRaw: vi.fn().mockResolvedValue(0),
        demoLead: { findUnique: vi.fn().mockResolvedValue({ id: "lead-1", email: "demo@acme.com", workspaceId: "ws-1" }) },
        crmProspectWorkspace: { findFirst: vi.fn().mockResolvedValue(existing) } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await provisionProspectWorkspace(dummyActor, {
        demoLeadId: "lead-1",
        adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1",
      });

      expect(result).toEqual(existing);
      expect(tx.crmProspectWorkspace.findFirst).toHaveBeenCalled();
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.crmProspectWorkspace.findFirst.mock.invocationCallOrder[0]!);
    });

    it("revalidates the matched contact under lock before creating a workspace", async () => {
      const { prisma } = await import("@corgtex/shared"), { provisionProspectWorkspace } = await import("./crm");
      const create = vi.fn(), tx = {
        $executeRaw: vi.fn().mockResolvedValue(0),
        demoLead: { findUnique: vi.fn().mockResolvedValue({ id: "lead-1", email: "demo@acme.com", workspaceId: "ws-1" }) },
        crmProspectWorkspace: { findFirst: vi.fn().mockResolvedValue(null) },
        crmContact: { findFirst: vi.fn().mockResolvedValueOnce({ id: "contact-1", accountId: "account-1" }).mockResolvedValueOnce(null),
          findMany: vi.fn().mockResolvedValue([{ id: "contact-1", accountId: "account-1" }]) },
        workspace: { create },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(provisionProspectWorkspace(dummyActor, { demoLeadId: "lead-1", adminEmail: "admin@acme.com",
        crmWorkspaceId: "ws-1" })).rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
      expect(lockWorkspaceArchiveArtifact).toHaveBeenCalledWith(tx, "CrmContact", "contact-1");
      expect(create).not.toHaveBeenCalled();
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

    it("registers an account prospect workspace with the customer lifecycle only for the explicit internal action", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { registerCrmAccountCustomerLifecycle } = await import("./crm");

      const tx = {
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Acme Corp",
            slug: "acme-corp",
            relationshipType: "PROSPECT",
            lifecycleStage: "PILOT",
            archivedAt: null,
          }),
          update: vi.fn().mockResolvedValue({
            id: "account-1",
            relationshipType: "CLIENT",
            lifecycleStage: "ACTIVE",
          }),
        },
        crmProspectWorkspace: {
          findUnique: vi.fn().mockResolvedValue({
            id: "pw-1",
            crmWorkspaceId: "ws-1",
            accountId: "account-1",
            targetWorkspaceId: "ws-client",
            targetWorkspace: {
              id: "ws-client",
              slug: "acme-client",
              name: "Acme Client",
              description: "Pilot workspace",
            },
          }),
        },
        customerAccount: {
          upsert: vi.fn().mockResolvedValue({ id: "cust-1", slug: "acme-corp", primaryDeploymentId: null }),
          findUnique: vi.fn().mockResolvedValue({ id: "cust-1", primaryDeploymentId: null }),
          update: vi.fn().mockResolvedValue({ id: "cust-1", primaryDeploymentId: "deployment-1" }),
        },
        customerDeployment: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: "deployment-1", customerAccountId: "cust-1" }),
        },
        auditLog: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      const result = await registerCrmAccountCustomerLifecycle(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        prospectWorkspaceId: "pw-1",
      });

      expect(tx.customerAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { slug: "acme-corp" },
        create: expect.objectContaining({
          displayName: "Acme Corp",
          status: "ACTIVE",
          managementAuthority: "CORGTEX",
        }),
      }));
      expect(tx.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          customerAccountId: "cust-1",
          managedWorkspaceId: "ws-client",
          remoteWorkspaceSlug: "acme-client",
        }),
      }));
      expect(result.account).toMatchObject({ relationshipType: "CLIENT", lifecycleStage: "ACTIVE" });
    });

    it("rejects customer lifecycle registration for non-global actors before mutating control-plane state", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { requireGlobalOperator } = await import("./auth");
      const { registerCrmAccountCustomerLifecycle } = await import("./crm");

      vi.mocked(requireGlobalOperator).mockImplementationOnce(() => {
        throw new Error("Only global operators can perform this action.");
      });

      await expect(registerCrmAccountCustomerLifecycle(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        prospectWorkspaceId: "pw-1",
      })).rejects.toThrow("Only global operators");

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects customer lifecycle registration for cross-workspace or unlinked prospect workspaces", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { registerCrmAccountCustomerLifecycle } = await import("./crm");

      const tx = {
        crmAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "account-1",
            workspaceId: "ws-1",
            name: "Acme Corp",
            slug: "acme-corp",
            relationshipType: "PROSPECT",
            lifecycleStage: "PILOT",
            archivedAt: null,
          }),
          update: vi.fn(),
        },
        crmProspectWorkspace: {
          findUnique: vi.fn()
            .mockResolvedValueOnce({
              id: "pw-other",
              crmWorkspaceId: "ws-other",
              accountId: "account-1",
              targetWorkspace: { id: "target-other", slug: "other", name: "Other" },
            })
            .mockResolvedValueOnce({
              id: "pw-unlinked",
              crmWorkspaceId: "ws-1",
              accountId: "account-other",
              targetWorkspace: { id: "target-1", slug: "target", name: "Target" },
            }),
        },
        customerAccount: { upsert: vi.fn() },
        customerDeployment: { upsert: vi.fn() },
        auditLog: { create: vi.fn() },
      };
      vi.mocked(prisma.$transaction)
        .mockImplementationOnce((async (fn: any) => fn(tx)) as any)
        .mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await expect(registerCrmAccountCustomerLifecycle(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        prospectWorkspaceId: "pw-other",
      })).rejects.toThrow();
      await expect(registerCrmAccountCustomerLifecycle(dummyActor, {
        workspaceId: "ws-1",
        accountId: "account-1",
        prospectWorkspaceId: "pw-unlinked",
      })).rejects.toThrow();

      expect(tx.customerAccount.upsert).not.toHaveBeenCalled();
      expect(tx.customerDeployment.upsert).not.toHaveBeenCalled();
      expect(tx.crmAccount.update).not.toHaveBeenCalled();
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
      const contact = { id: "contact-1", workspaceId: "ws-1", accountId: null, archivedAt: null, tags: ["existing"] };
      const tx = { crmContact: {
        findUnique: vi.fn().mockResolvedValue(contact), findMany: vi.fn().mockResolvedValue([{ accountId: null }]),
        findFirst: vi.fn().mockResolvedValue(contact), update: vi.fn(),
      }, crmActivity: { create: vi.fn() } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await applyEnrichmentResult("ws-1", "contact-1", {
        industry: "Healthcare",
        headquarters: "New York",
        description: "Care delivery platform",
        confidence: 0.91,
      });

      expect(tx.crmContact.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({
        id: "contact-1", workspaceId: "ws-1", archivedAt: null,
      }) });
      expect(tx.crmContact.update).toHaveBeenCalledWith({
        where: { id: "contact-1" },
        data: { tags: ["existing", "Healthcare", "New York"] },
      });
      expect(tx.crmActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            contactId: "contact-1",
            title: "Applied Enrichment Data",
          }),
        }),
      );
    });
    it("does not write enrichment after a linked parent is archived under lock", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { applyEnrichmentResult } = await import("./crm-enrichment");
      const update = vi.fn(); const create = vi.fn();
      const tx = { crmContact: {
        findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null }),
        findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]), findFirst: vi.fn().mockResolvedValue(null), update,
      }, crmActivity: { create } };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(applyEnrichmentResult("ws-1", "contact-1", { confidence: 0.9 })).rejects.toThrow("Contact not found.");
      expect(update).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    });
  });

  describe("recordDripFollowUp", () => {
    it("scopes the lead lookup to the workspace before recording the follow-up", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { recordDripFollowUp } = await import("./crm-drip");
      const lead = {
        id: "lead-1",
        workspaceId: "ws-1",
        followUpCount: 1,
        convertedContactId: "contact-1",
      };
      const contact = { id: "contact-1", workspaceId: "ws-1", accountId: null, archivedAt: null };
      const tx = {
        demoLead: { findFirst: vi.fn().mockResolvedValue(lead), update: vi.fn() },
        crmContact: { findUnique: vi.fn().mockResolvedValue(contact), findMany: vi.fn().mockResolvedValue([{ accountId: null }]),
          findFirst: vi.fn().mockResolvedValue(contact) },
        crmActivity: { create: vi.fn() },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);

      await recordDripFollowUp("ws-1", "lead-1", "Checking in.");

      expect(tx.demoLead.findFirst).toHaveBeenCalledWith({
        where: {
          id: "lead-1",
          workspaceId: "ws-1",
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
    it("does not advance drip state after a converted contact parent is archived under lock", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { recordDripFollowUp } = await import("./crm-drip");
      const update = vi.fn(); const create = vi.fn();
      const tx = {
        demoLead: { findFirst: vi.fn().mockResolvedValue({ id: "lead-1", workspaceId: "ws-1", convertedContactId: "contact-1" }), update },
        crmContact: { findUnique: vi.fn().mockResolvedValue({ id: "contact-1", workspaceId: "ws-1", accountId: "account-1", archivedAt: null }),
          findMany: vi.fn().mockResolvedValue([{ accountId: "account-1" }]), findFirst: vi.fn().mockResolvedValue(null) },
        crmActivity: { create },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(tx)) as any);
      await expect(recordDripFollowUp("ws-1", "lead-1", "Blocked")).rejects.toThrow("Contact not found.");
      expect(update).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    });
  });
});
