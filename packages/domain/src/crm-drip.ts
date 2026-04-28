import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

export async function recordDripFollowUp(
  workspaceId: string,
  demoLeadId: string,
  emailContent: string
) {
  const lead = await prisma.demoLead.findUnique({
    where: { id: demoLeadId },
  });

  invariant(lead && lead.workspaceId === workspaceId, 404, "NOT_FOUND", "DemoLead not found.");

  await prisma.$transaction(async (tx) => {
    await tx.demoLead.update({
      where: { id: demoLeadId },
      data: {
        followUpCount: { increment: 1 },
        lastFollowUpAt: new Date(),
      },
    });

    // Create an activity to record that the email was sent
    await tx.crmActivity.create({
      data: {
        workspaceId,
        type: "EMAIL",
        title: `Sent follow-up #${lead.followUpCount + 1}`,
        bodyMd: emailContent,
        // If the lead was already converted, we can attach the activity to the contact.
        // Otherwise, it just stays as a workspace-level log.
        contactId: lead.convertedContactId,
      },
    });
  });
}
