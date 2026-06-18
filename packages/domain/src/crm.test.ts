import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------- mocks ----------

vi.mock("@corgtex/shared", () => {
  return {
    env: {
      APP_URL: "https://app.corgtex.test",
    },
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
        create: vi.fn(),
        updateMany: vi.fn(),
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
            update: vi.fn().mockResolvedValue({ id: "deal-1", workspaceId: "ws-1", stage: "QUALIFIED" }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmDealStageTransition: {
            create: vi.fn().mockResolvedValue({ id: "transition-1" }),
          },
          crmActivity: {
            findMany: vi.fn(),
            count: vi.fn(),
            create: vi.fn().mockResolvedValue({ id: "activity-1" }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmConversationMessage: {
            create: vi.fn().mockResolvedValue({ id: "msg-1", conversationId: "conv-1" }),
          },
          crmConversation: {
            update: vi.fn(),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          crmProspectWorkspace: {
            findMany: vi.fn(),
            count: vi.fn(),
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
          crmAccount: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "account-1", workspaceId: "ws-1", domain: "example.com" }),
          },
          crmContact: {
            upsert: vi.fn().mockResolvedValue({ id: "contact-1" }),
          },
        })) as any);

      await captureDemoLead({ email: "demo@example.com" });

      expect(appendEvents).not.toHaveBeenCalled();
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

    it("inherits the contact account when creating a deal", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createDeal } = await import("./crm");

      const tx = {
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            archivedAt: null,
          }),
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
    });

    it("backfills accounts and related CRM records idempotently", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { backfillCrmAccountsForWorkspace } = await import("./crm");

      const tx = {
        crmContact: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "contact-1",
              email: "founder@acme.com",
              company: "Acme Corp",
              source: "import",
            },
          ]),
          update: vi.fn().mockResolvedValue({ id: "contact-1", accountId: "account-1" }),
        },
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
        crmActivity: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
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
      expect(tx.crmContact.update).toHaveBeenCalledWith({
        where: { id: "contact-1" },
        data: { accountId: "account-1" },
      });

      const emptyTx = {
        crmContact: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: any) => fn(emptyTx)) as any);

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
        where: { workspaceId: "ws-1", accountId: "account-1" },
        take: 10,
      }));
      expect(result.total).toBe(1);
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
        where: { crmWorkspaceId: "ws-1", accountId: "account-1", status: "ACTIVE" },
        take: 5,
      }));
      expect(result.total).toBe(1);
    });
  });

  describe("deal stage transitions", () => {
    it("records an initial stage transition when creating a deal", async () => {
      const { prisma } = await import("@corgtex/shared");
      const { createDeal } = await import("./crm");

      const tx = {
        crmContact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "contact-1",
            workspaceId: "ws-1",
            accountId: "account-1",
            archivedAt: null,
          }),
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
