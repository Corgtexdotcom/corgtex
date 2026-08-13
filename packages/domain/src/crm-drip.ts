import { prisma } from "@corgtex/shared";
import { activeCrmParentWhere, lockCrmLinkClosure } from "./crm-archive-guards";
import { invariant } from "./errors";

export async function recordDripFollowUp(
  workspaceId: string,
  demoLeadId: string,
  emailContent: string,
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.demoLead.findFirst({ where: { id: demoLeadId, workspaceId } });
    invariant(lead, 404, "NOT_FOUND", "DemoLead not found.");
    const links = lead.convertedContactId ? await tx.crmContact.findUnique({ where: { id: lead.convertedContactId } }) : null;
    if (lead.convertedContactId) invariant(links && links.workspaceId === workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    if (links) await lockCrmLinkClosure(tx, workspaceId, { contactId: links.id, accountId: links.accountId });
    const contact = links ? await tx.crmContact.findFirst({ where: { id: links.id, workspaceId, archivedAt: null,
      ...activeCrmParentWhere(["account"]) } }) : null;
    if (links) invariant(contact, 404, "NOT_FOUND", "Contact not found.");

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
        accountId: contact?.accountId ?? null,
        type: "EMAIL",
        title: `Sent follow-up #${lead.followUpCount + 1}`,
        bodyMd: emailContent,
        contactId: contact?.id ?? null,
      },
    });
  });
}
