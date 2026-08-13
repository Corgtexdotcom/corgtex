import { describe, expect, it, beforeAll } from "vitest";
import { prisma } from "@corgtex/shared";
import {
  captureDemoLead,
  submitQualification,
  approveQualification,
  rejectQualification,
  receiveEmailReply,
  syncEmailReplyToConversation,
  provisionProspectWorkspace,
  archiveCrmAccount, archiveCrmActivity, archiveContact, archiveCrmDeal, completeActivity,
  listContacts, listCrmActivities, listDeals, updateActivity,
} from "./crm";
import { purgeWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";

describe("CRM Integration Lifecycle", () => {
  let adminActor: any;
  let workspace: any;
  let adminUser: any;

  beforeAll(async () => {
    adminUser = await prisma.user.create({
      data: {
        email: `crm-admin-${Date.now()}@corgtex.local`,
        displayName: "CRM Admin",
        passwordHash: "dummy",
      },
    });

    workspace = await prisma.workspace.create({
      data: {
        slug: `crm-test-ws-${Date.now()}`,
        name: "CRM Test Workspace",
        description: "Test",
      },
    });

    const member = await prisma.member.create({
      data: {
        workspaceId: workspace.id,
        userId: adminUser.id,
        role: "ADMIN",
      },
    });

    adminActor = { kind: "user", user: adminUser, member };
  });

  it("preserves non-cascading parent restore and independently archived children", async () => {
    const suffix = Date.now().toString();
    const account = await prisma.crmAccount.create({ data: { workspaceId: workspace.id, name: `Archive ${suffix}`, slug: `archive-${suffix}` } });
    const contact = await prisma.crmContact.create({ data: { workspaceId: workspace.id, accountId: account.id, email: `linked-${suffix}@example.test` } });
    const unlinked = await prisma.crmContact.create({ data: { workspaceId: workspace.id, email: `unlinked-${suffix}@example.test` } });
    const deal = await prisma.crmDeal.create({ data: { workspaceId: workspace.id, accountId: account.id, contactId: contact.id, title: "Archive deal" } });
    const activity = await prisma.crmActivity.create({ data: { workspaceId: workspace.id, accountId: account.id, contactId: contact.id,
      dealId: deal.id, title: "Archive activity" } });
    await archiveCrmAccount(adminActor, { workspaceId: workspace.id, accountId: account.id });
    expect(await prisma.crmContact.findUnique({ where: { id: contact.id } })).toMatchObject({ archivedAt: null });
    expect((await listContacts(adminActor, workspace.id)).items.map((item) => item.id)).toContain(unlinked.id);
    expect((await listDeals(adminActor, workspace.id)).items.map((item) => item.id)).not.toContain(deal.id);
    expect((await listCrmActivities(adminActor, workspace.id)).items.map((item) => item.id)).not.toContain(activity.id);
    await restoreWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmAccount", entityId: account.id });
    expect((await listDeals(adminActor, workspace.id)).items.map((item) => item.id)).toContain(deal.id);
    expect((await listCrmActivities(adminActor, workspace.id)).items.map((item) => item.id)).toContain(activity.id);
    await archiveCrmDeal(adminActor, { workspaceId: workspace.id, dealId: deal.id });
    await archiveCrmActivity(adminActor, { workspaceId: workspace.id, activityId: activity.id });
    await expect(updateActivity(adminActor, { workspaceId: workspace.id, activityId: activity.id, title: "Must fail" })).rejects.toThrow("Activity not found");
    await expect(completeActivity(adminActor, { workspaceId: workspace.id, activityId: activity.id })).rejects.toThrow("Activity not found");
    await archiveCrmAccount(adminActor, { workspaceId: workspace.id, accountId: account.id });
    await expect(restoreWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmDeal", entityId: deal.id })).rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
    await expect(restoreWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmActivity", entityId: activity.id })).rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
    await restoreWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmAccount", entityId: account.id });
    expect((await listDeals(adminActor, workspace.id)).items.map((item) => item.id)).not.toContain(deal.id);
    expect((await listCrmActivities(adminActor, workspace.id, { archiveFilter: "all" })).items.map((item) => item.id)).toContain(activity.id);
    const ledgers = await prisma.workspaceArchiveRecord.findMany({ where: { workspaceId: workspace.id,
      entityId: { in: [deal.id, activity.id] }, restoredAt: null } });
    expect(ledgers.map((record) => record.entityType).sort()).toEqual(["CrmActivity", "CrmDeal"]);
    const soleDeal = await prisma.crmDeal.create({ data: { workspaceId: workspace.id, contactId: unlinked.id, title: "Sole-link deal" } });
    await prisma.crmActivity.create({ data: { workspaceId: workspace.id, dealId: soleDeal.id, title: "Sole-link activity" } });
    await archiveCrmDeal(adminActor, { workspaceId: workspace.id, dealId: soleDeal.id });
    await expect(purgeWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmDeal",
      entityId: soleDeal.id, reason: "integration test" })).rejects.toMatchObject({ code: "CRM_ACTIVITY_ORPHAN" });
    const survivingActivity = await prisma.crmActivity.create({ data: { workspaceId: workspace.id, accountId: account.id,
      contactId: contact.id, dealId: deal.id, title: "Multiple-link activity" } });
    await purgeWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmDeal", entityId: deal.id, reason: "integration test" });
    expect(await prisma.crmActivity.findUnique({ where: { id: activity.id } })).toMatchObject({ dealId: null, archivedAt: expect.any(Date) });
    expect(await prisma.crmActivity.findUnique({ where: { id: survivingActivity.id } })).toMatchObject({ dealId: null, accountId: account.id, archivedAt: null });
    await archiveContact(adminActor, { workspaceId: workspace.id, contactId: contact.id });
    await purgeWorkspaceArtifact(adminActor, { workspaceId: workspace.id, entityType: "CrmContact", entityId: contact.id, reason: "integration test" });
    expect(await prisma.crmActivity.findUnique({ where: { id: activity.id } })).toMatchObject({ contactId: null, archivedAt: expect.any(Date) });
    expect(await prisma.workspaceArchiveRecord.findFirst({ where: { workspaceId: workspace.id, entityType: "CrmActivity",
      entityId: activity.id, restoredAt: null, purgedAt: null } })).toBeTruthy();
  });
  it("completes the full approval and provisioning lifecycle", async () => {
    // 1. Capture flow
    const captureParams = {
      email: `prospect-${Date.now()}@acme.test`,
      source: "demo_gate_integration",
      workspaceSlug: workspace.slug,
    };

    const { demoLead, contact } = await captureDemoLead(captureParams);
    expect(demoLead.email).toBe(captureParams.email);
    expect(demoLead.qualifyToken).toBeTruthy();
    expect(contact.email).toBe(captureParams.email);
    // 2. Qualify flow
    const qualResponse = await submitQualification({
      token: demoLead.qualifyToken!,
      companyName: "Acme Corp Test",
      website: "https://acme.test",
      aiExperience: "Beginner",
      helpNeeded: "Need an integrated CRM.",
    });

    expect(qualResponse.status).toBe("PENDING_REVIEW");
    expect(qualResponse.companyName).toBe("Acme Corp Test");

    // 3. Review flow - Approve
    const approvedQual = await approveQualification(adminActor, {
      workspaceId: workspace.id,
      qualificationId: qualResponse.id,
    });

    expect(approvedQual.status).toBe("APPROVED");

    // Contact should have been updated by approval
    const updatedContact = await prisma.crmContact.findUnique({
      where: { id: contact.id },
    });
    expect(updatedContact?.company).toBe("Acme Corp Test");

    // 7. Provisioning flow
    const provisionResult = await provisionProspectWorkspace(adminActor, {
      crmWorkspaceId: workspace.id,
      adminEmail: "test@acme.test",
      demoLeadId: demoLead.id,
    });

    expect(provisionResult.id).toBeDefined();

    const prospectWorkspace = await prisma.crmProspectWorkspace.findUnique({
      where: { id: provisionResult.id },
      include: { targetWorkspace: true },
    });
    expect(prospectWorkspace?.targetWorkspace).toBeDefined();
    const customerAccount = await prisma.customerAccount.findUnique({
      where: { slug: prospectWorkspace!.targetWorkspace.slug },
      include: { primaryDeployment: true },
    });
    expect(customerAccount).toBeNull();
  });

  it("handles the reject flow correctly", async () => {
    const { demoLead } = await captureDemoLead({
      email: `reject-${Date.now()}@acme.test`,
      source: "demo_gate",
      workspaceSlug: workspace.slug,
    });

    const qualResponse = await submitQualification({
      token: demoLead.qualifyToken!,
      companyName: "Bad Fit Inc",
      website: "badfit.com",
      aiExperience: "None",
      helpNeeded: "Nothing",
    });

    const rejectedQual = await rejectQualification(adminActor, {
      workspaceId: workspace.id,
      qualificationId: qualResponse.id,
      note: "Not a good fit for now.",
    });

    expect(rejectedQual.status).toBe("REJECTED");
    expect(rejectedQual.reviewNote).toBe("Not a good fit for now.");
  });

  it("handles inbound email reply and conversation syncing", async () => {
    const { demoLead } = await captureDemoLead({
      email: `email-reply-${Date.now()}@acme.test`,
      source: "demo_gate",
      workspaceSlug: workspace.slug,
    });

    const rawEmailReply = "Yes, I am interested in learning more.";

    // 5. Email reply flow
    const qualResponse = await receiveEmailReply({
      fromEmail: demoLead.email,
      subject: "Re: Demo",
      bodyText: rawEmailReply,
    });

    expect(qualResponse.status).toBe("PENDING_REVIEW");
    expect(qualResponse.rawEmailReply).toBe(rawEmailReply);
    expect(qualResponse.responseChannel).toBe("email_reply");

    // 6. Conversation flow
    await syncEmailReplyToConversation({
      fromEmail: demoLead.email,
      subject: "Re: Demo",
      bodyText: rawEmailReply,
    });

    const conversation = await prisma.crmConversation.findFirst({
      where: { workspaceId: workspace.id, demoLeadId: demoLead.id },
      include: { messages: true },
    });

    expect(conversation).toBeDefined();
    expect(conversation?.messages.length).toBe(1);
    expect(conversation?.messages[0].bodyMd).toBe(rawEmailReply);
  });
});
