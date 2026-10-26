import { randomUUID } from "node:crypto";
import type { DemoLead, CrmQualification, Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";

export function crmIngressActor(workspaceId: string): AppActor {
  return { kind: "agent", authProvider: "bootstrap", label: "crm-public-ingress", workspaceIds: [workspaceId] };
}

/** A create UUID distinguishes a fresh upsert from any preexisting mixed-content lead. */
export async function recordFreshDemoLeadLineage(tx: Prisma.TransactionClient, lead: DemoLead,
  request: { createdId: string; email: string; source: string }): Promise<LineageRoot[]> {
  invariant(lead.email === request.email, 409, "SOURCE_CHANGED", "Lead intake identity changed.");
  const actor = crmIngressActor(lead.workspaceId);
  // A new submission source is not evidence for an older stored source value.
  if (lead.source !== request.source) return [];
  const roots = await captureArtifactInputProof(actor, lead.workspaceId,
    [{ kind: "DemoLeadIntakeInput", id: lead.id, snapshot: lead }], tx);
  if (lead.id === request.createdId) {
    invariant(lead.companyHint == null && lead.utmSource == null && lead.convertedContactId == null
      && lead.followUpCount === 0 && lead.lastFollowUpAt == null && lead.convertedAt == null,
    409, "UNKNOWN_LINEAGE", "A fresh lead contains unexplained generated fields.");
    await recordArtifactInputLineage({ tx, actor, workspaceId: lead.workspaceId,
      artifact: { kind: "DemoLead", id: lead.id }, content: lead, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  }
  // Reused leads retain their prior full record manifest, including UNKNOWN.
  return captureImmutableArtifactInputProof(actor, lead.workspaceId, roots, tx);
}

/** Only exact fresh provider email fields are native; extracted/review fields are not. */
export async function recordFreshEmailQualificationLineage(tx: Prisma.TransactionClient, qualification: CrmQualification,
  request: { createdId: string; workspaceId: string; demoLeadId: string; bodyText: string; subject: string }) {
  invariant(qualification.id === request.createdId && qualification.workspaceId === request.workspaceId
    && qualification.demoLeadId === request.demoLeadId && qualification.responseChannel === "email_reply"
    && qualification.rawEmailReply === request.bodyText && qualification.rawEmailSubject === request.subject,
  409, "SOURCE_CHANGED", "Qualification intake identity changed.");
  invariant(qualification.status === "PENDING_REVIEW" && [qualification.companyName, qualification.website, qualification.roleTitle,
    qualification.aiExperience, qualification.helpNeeded, qualification.reviewNote, qualification.reviewedByUserId,
    qualification.reviewedAt, qualification.schedulingEmailSentAt].every(value => value == null),
  409, "UNKNOWN_LINEAGE", "A fresh email qualification contains unexplained derived fields.");
  const actor = crmIngressActor(request.workspaceId);
  const roots = await captureArtifactInputProof(actor, request.workspaceId, [
    { kind: "CrmQualificationEmailInput", id: qualification.id, snapshot: qualification },
    { kind: "DemoLeadIntakeInput", id: request.demoLeadId },
  ], tx);
  await recordArtifactInputLineage({ tx, actor, workspaceId: request.workspaceId,
    artifact: { kind: "CrmQualification", id: qualification.id }, content: qualification,
    origin: "DERIVED", inputs: [], inheritedRoots: roots });
}

/** Native form input is admitted only while its current bearer link is verified under lock. */
export async function createFreshFormQualification(tx: Prisma.TransactionClient, request: {
  workspaceId: string; demoLeadId: string; token: string;
  companyName: string; website: string; roleTitle?: string; aiExperience: string; helpNeeded: string;
}) {
  await tx.$queryRaw`SELECT id FROM "DemoLead" WHERE id = ${request.demoLeadId} AND "workspaceId" = ${request.workspaceId} FOR UPDATE`;
  const lead = await tx.demoLead.findFirst({ where: { id: request.demoLeadId, workspaceId: request.workspaceId, qualifyToken: request.token } });
  invariant(lead, 410, "QUALIFICATION_LINK_UNAVAILABLE", "This qualification link is no longer available. Please start a new request.");
  const actor = crmIngressActor(request.workspaceId);
  const intakeRoots = await captureArtifactInputProof(actor, request.workspaceId,
    [{ kind: "DemoLeadIntakeInput", id: lead.id, snapshot: lead }], tx);
  const fields = { companyName: request.companyName.trim(), website: request.website.trim(),
    roleTitle: request.roleTitle?.trim() || null, aiExperience: request.aiExperience.trim(), helpNeeded: request.helpNeeded.trim() };
  const qualification = await tx.crmQualification.create({ data: { id: randomUUID(), workspaceId: request.workspaceId,
    demoLeadId: lead.id, responseChannel: "form", status: "PENDING_REVIEW", ...fields } });
  const input = await tx.crmQualificationFormInput.create({ data: { id: randomUUID(), workspaceId: request.workspaceId,
    demoLeadId: lead.id, qualificationId: qualification.id, ...fields } });
  const roots = await captureArtifactInputProof(actor, request.workspaceId,
    [{ kind: "CrmQualificationFormInput", id: input.id, snapshot: input }], tx);
  await recordArtifactInputLineage({ tx, actor, workspaceId: request.workspaceId,
    artifact: { kind: "CrmQualification", id: qualification.id }, content: qualification,
    origin: "DERIVED", inputs: [], inheritedRoots: [...intakeRoots, ...roots] });
  return { qualification, lead };
}
