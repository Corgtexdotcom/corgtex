import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, invariant, isArtifactInputProofReadable,
  recordArtifactInputLineage, type LineageInput, type LineageRoot } from "@corgtex/domain";

const crmJobTypes = ["agent.crm-email-extraction", "agent.crm-lead-enrichment", "agent.crm-drip-followup"];
type Draft = { workspaceId?: string | null; eventId?: string | null; type: string; payload: Prisma.InputJsonValue;
  dedupeKey: string; dependsOnJobId?: string | null };
const unavailable = (error: unknown) => error && typeof error === "object" && "code" in error
  && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code));

/** Frozen outbox adapters call this before generic enqueue. No raw event text becomes job content. */
export async function enqueueCrmLineageJob(tx: Prisma.TransactionClient, draft: Draft): Promise<{
  handled: boolean; scheduled: boolean; jobId?: string;
}> {
  if (!crmJobTypes.includes(draft.type)) return { handled: false, scheduled: false };
  const workspaceId = draft.workspaceId;
  invariant(draft.payload && typeof draft.payload === "object" && !Array.isArray(draft.payload),
    400, "INVALID_INPUT", "CRM job input must be an object.");
  const requested = draft.payload as Prisma.InputJsonObject;
  invariant(workspaceId, 400, "INVALID_INPUT", "CRM jobs require a workspace.");
  const actor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "crm-job-scheduler", workspaceIds: [workspaceId] };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-job:${workspaceId}:${draft.dedupeKey}`}, 0))`;
  const existing = await tx.workflowJob.findUnique({ where: { dedupeKey: draft.dedupeKey } });
  if (existing) {
    if (existing.workspaceId !== workspaceId || existing.type !== draft.type) return { handled: true, scheduled: false };
    const prior = existing.payload;
    if (!prior || typeof prior !== "object" || Array.isArray(prior)) return { handled: true, scheduled: false };
    if (draft.type === "agent.crm-drip-followup") {
      if (prior.demoLeadId !== requested.demoLeadId || prior.followUpNumber !== requested.followUpNumber) return { handled: true, scheduled: false };
    } else if (existing.eventId !== (draft.eventId ?? null)
      || prior.aggregateId !== (requested.qualificationId ?? requested.aggregateId)) return { handled: true, scheduled: false };
    try {
      // A retry can reuse an already attested job, never mint a receipt for legacy payloads.
      await captureArtifactInputProof(actor, workspaceId, [{ kind: "WorkflowJobInput", id: existing.id, snapshot: existing }], tx);
      return { handled: true, scheduled: false, jobId: existing.id };
    } catch (error) { if (unavailable(error)) return { handled: true, scheduled: false }; throw error; }
  }
  const inputs: Array<LineageInput & { snapshot?: Record<string, unknown> }> = [];
  let payload: Prisma.InputJsonObject;
  if (draft.type === "agent.crm-drip-followup") {
    const leadId = typeof requested.demoLeadId === "string" ? requested.demoLeadId : "";
    await tx.$queryRaw`SELECT id FROM "DemoLead" WHERE id = ${leadId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const lead = await tx.demoLead.findFirst({ where: { id: leadId, workspaceId } });
    if (!lead || lead.convertedAt || !Number.isSafeInteger(lead.followUpCount) || lead.followUpCount < 0) return { handled: true, scheduled: false };
    if (requested.followUpNumber !== lead.followUpCount + 1) return { handled: true, scheduled: false };
    inputs.push({ kind: "DemoLead", id: lead.id, snapshot: lead });
    payload = { demoLeadId: lead.id, followUpNumber: lead.followUpCount + 1 };
  } else {
    const qualificationId = typeof requested.qualificationId === "string" ? requested.qualificationId
      : typeof requested.aggregateId === "string" ? requested.aggregateId : "";
    await tx.$queryRaw`SELECT id FROM "CrmQualification" WHERE id = ${qualificationId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const qualification = await tx.crmQualification.findFirst({ where: { id: qualificationId, workspaceId } });
    if (!qualification) return { handled: true, scheduled: false };
    inputs.push({ kind: "CrmQualification", id: qualification.id, snapshot: qualification });
    if (draft.type === "agent.crm-email-extraction") {
      if (qualification.responseChannel !== "email_reply" || !qualification.rawEmailReply) return { handled: true, scheduled: false };
      payload = { eventId: draft.eventId ?? "", aggregateId: qualification.id, qualificationId: qualification.id };
    } else {
      if (qualification.status !== "APPROVED") return { handled: true, scheduled: false };
      const lead = await tx.demoLead.findFirst({ where: { id: qualification.demoLeadId, workspaceId } });
      if (!lead) return { handled: true, scheduled: false };
      inputs.push({ kind: "DemoLeadIntakeInput", id: lead.id, snapshot: lead });
      const contact = await tx.crmContact.findFirst({ where: { workspaceId, email: lead.email, archivedAt: null } });
      if (!contact) return { handled: true, scheduled: false };
      inputs.push({ kind: "CrmContact", id: contact.id, snapshot: contact });
      if (contact.accountId) inputs.push({ kind: "CrmAccount", id: contact.accountId });
      payload = { eventId: draft.eventId ?? "", aggregateId: qualification.id, email: lead.email };
    }
  }
  let roots: LineageRoot[];
  try {
    const liveRoots = await captureArtifactInputProof(actor, workspaceId, inputs, tx);
    roots = await captureImmutableArtifactInputProof(actor, workspaceId, liveRoots, tx);
    invariant(await isArtifactInputProofReadable(actor, workspaceId, liveRoots, tx), 409, "SOURCE_CHANGED", "CRM job inputs changed.");
  } catch (error) { if (unavailable(error)) return { handled: true, scheduled: false }; throw error; }
  // Once persistence begins, every failure propagates so the caller rolls back the transaction.
  const job = await tx.workflowJob.create({ data: { id: randomUUID(), workspaceId, eventId: draft.eventId ?? null,
    type: draft.type, payload, dedupeKey: draft.dedupeKey, dependsOnJobId: draft.dependsOnJobId ?? null } });
  await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "WorkflowJobInput", id: job.id },
    content: job, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return { handled: true, scheduled: true, jobId: job.id };
}
