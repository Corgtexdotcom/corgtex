import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { prisma } from "@corgtex/shared";
import { 
  captureDemoLead, 
  submitQualification, 
  approveQualification, 
  rejectQualification,
  receiveEmailReply,
  syncEmailReplyToConversation,
  provisionProspectWorkspace
} from "./crm";

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
      },
    });

    adminActor = { kind: "user", user: adminUser, member };
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
      include: { targetWorkspace: true }
    });
    expect(prospectWorkspace?.targetWorkspace).toBeDefined();
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
