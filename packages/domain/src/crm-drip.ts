import type { Prisma } from "@prisma/client";
import { prisma, EmailSendError, type AppActor, type EmailSendResult, type EmailAttemptControls } from "@corgtex/shared";
import { activeCrmParentWhere, lockCrmLinkClosure } from "./crm-archive-guards";
import { mergeArtifactInputProofs } from "./digest-lineage";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureImmutableArtifactInputProof, currentArtifactInputRoots, preserveUnknownArtifactInputSnapshot,
  isArtifactInputProofReadable, isArtifactInputProofPubliclyShareable } from "./source-lineage";

export type DripDeliveryOutcome =
  | { status: "PROVIDER_ACCEPTED"; providerMessageId: string; followUpRecorded: boolean }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: "PROVIDER_REJECTED"; providerCode: string }
  | { status: "UNKNOWN"; reason: "PROVIDER_RESPONSE_UNCERTAIN" | "MISSING_PROVIDER_MESSAGE_ID" };

export async function recordDripFollowUp(
  workspaceId: string,
  demoLeadId: string,
  emailContent: string,
  options: ProducerLineageParams & {
    actor?: AppActor;
    expectedFollowUpNumber?: number;
    operationId?: string;
    /** Called only after the durable effect reservation and current source/recipient checks. */
    send?: (recipient: string, operationId: string, controls: EmailAttemptControls) => Promise<EmailSendResult>;
  } = {},
) {
  const actor: AppActor = options.actor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-drip-followup", workspaceIds: [workspaceId] };
  await requireWorkspaceMembership({ actor, workspaceId });
  const load = async (tx: Prisma.TransactionClient) => {
    await requireWorkspaceMembership({ actor, workspaceId, tx });
    await assertArtifactInputWriteFence(tx);
    await tx.$queryRaw`SELECT id FROM "DemoLead" WHERE id = ${demoLeadId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const lead = await tx.demoLead.findFirst({ where: { id: demoLeadId, workspaceId } });
    invariant(lead, 404, "NOT_FOUND", "DemoLead not found.");
    const links = lead.convertedContactId ? await tx.crmContact.findUnique({ where: { id: lead.convertedContactId } }) : null;
    if (lead.convertedContactId) invariant(links && links.workspaceId === workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    if (links) await lockCrmLinkClosure(tx, workspaceId, { contactId: links.id, accountId: links.accountId });
    const contact = links ? await tx.crmContact.findFirst({ where: { id: links.id, workspaceId, archivedAt: null,
      ...activeCrmParentWhere(["account"]) } }) : null;
    if (links) invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    if (options.expectedFollowUpNumber !== undefined) invariant(Number.isSafeInteger(options.expectedFollowUpNumber)
      && options.expectedFollowUpNumber === lead.followUpCount + 1, 409, "SOURCE_CHANGED", "This follow-up was already sent or its lead changed.");
    let roots = options.lineageRoots ?? [];
    if (roots.length) {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Drip inputs changed before recording.");
      roots = mergeArtifactInputProofs(roots, await captureArtifactInputProof(actor, workspaceId,
        [{ kind: "DemoLead", id: demoLeadId, snapshot: lead }, { kind: "DemoLeadIntakeInput", id: demoLeadId },
          ...(contact ? [{ kind: "CrmContact" as const, id: contact.id, snapshot: contact }] : []),
          ...(contact?.accountId ? [{ kind: "CrmAccount" as const, id: contact.accountId }] : [])], tx));
    }
    if (options.send) {
      invariant(options.operationId && options.expectedFollowUpNumber !== undefined && roots.length
        && options.lineageRoots?.some(root => root.kind === "WorkflowJobInput" && root.id === options.operationId),
      409, "UNKNOWN_LINEAGE", "Outbound follow-up needs its exact proven workflow operation.");
      const operation = await tx.workflowJob.findFirst({ where: { id: options.operationId, workspaceId, type: "agent.crm-drip-followup" },
        select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } });
      const payload = operation?.payload;
      invariant(payload && typeof payload === "object" && !Array.isArray(payload) && payload.demoLeadId === demoLeadId
        && Number(payload.followUpNumber ?? 1) === options.expectedFollowUpNumber,
      409, "SOURCE_CHANGED", "Outbound operation does not match its stored lead and follow-up number.");
      invariant(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, tx),
        403, "SOURCE_RESTRICTED", "Private or unknown context cannot be emailed to an external recipient.");
    }
    const frozen = roots.length ? await captureImmutableArtifactInputProof(actor, workspaceId, roots, tx) : [];
    const capture = { lineageInputs: [], lineageRoots: frozen };
    const leadReceipt = await prepareProducerLineage({ tx, actor, workspaceId, artifact: { kind: "DemoLead", id: demoLeadId },
      before: lead, capture, copied: true });
    const activityReceipt = await prepareProducerLineage({ tx, actor, workspaceId, capture, copied: true });
    return { lead, contact, roots, leadReceipt, activityReceipt };
  };

  // A committed reservation survives provider uncertainty or a crash after delivery. Never resend it automatically.
  const reservation = options.send ? await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-drip-effect:${workspaceId}:${options.operationId}`}, 0))`;
    const existing = await tx.crmActivity.findFirst({ where: { workspaceId, source: "crm-drip-effect", sourceExternalId: options.operationId } });
    invariant(!existing, 409, "DELIVERY_ALREADY_RESERVED", "Delivery was already attempted; inspect its result before retrying.");
    const loaded = await load(tx);
    const created = await tx.crmActivity.create({ data: { workspaceId, accountId: loaded.contact?.accountId ?? null,
      contactId: loaded.contact?.id ?? null, type: "EMAIL", title: "Follow-up delivery reserved", source: "crm-drip-effect",
      sourceExternalId: options.operationId, bodyMd: JSON.stringify({ operationId: options.operationId, status: "RESERVED", emailContent }) } });
    await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmActivity", id: created.id }, content: created, receipt: loaded.activityReceipt });
    return created;
  }) : null;

  const checkReservation = async (tx: Prisma.TransactionClient) => {
    if (reservation) await tx.$queryRaw`SELECT id FROM "CrmActivity" WHERE id = ${reservation.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (reservation) {
      const current = await tx.crmActivity.findFirst({ where: { id: reservation.id, workspaceId, archivedAt: null, source: "crm-drip-effect", sourceExternalId: options.operationId } });
      invariant(current && current.title === "Follow-up delivery reserved" && current.bodyMd === reservation.bodyMd,
        409, "DELIVERY_ALREADY_RESERVED", "Delivery reservation changed or was cancelled; inspect it before retrying.");
      await captureArtifactInputProof(actor, workspaceId, [{ kind: "CrmActivity", id: current.id, snapshot: current }], tx);
    }
  };
  const writeOutcome = async (tx: Prisma.TransactionClient, delivery: DripDeliveryOutcome, receipt: Awaited<ReturnType<typeof load>>["activityReceipt"]) => {
    invariant(reservation, 409, "DELIVERY_ALREADY_RESERVED", "A delivery reservation is required.");
    const titles = {
      PROVIDER_ACCEPTED: delivery.status === "PROVIDER_ACCEPTED" && delivery.followUpRecorded
        ? `Follow-up #${options.expectedFollowUpNumber} accepted by email provider`
        : "Follow-up accepted by email provider; recording requires recovery",
      SKIPPED: "Follow-up email skipped",
      FAILED: "Follow-up email rejected by provider",
      UNKNOWN: "Follow-up email outcome unknown; inspection required",
    };
    const activity = await tx.crmActivity.update({ where: { id: reservation.id }, data: {
      title: titles[delivery.status], bodyMd: JSON.stringify({ operationId: options.operationId, ...delivery, emailContent }),
    } });
    await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmActivity", id: activity.id }, content: activity, receipt });
  };

  let observedOutcome: DripDeliveryOutcome | undefined;
  let sendFailure: { error: unknown } | undefined;
  let result;
  try {
    result = await prisma.$transaction(async tx => {
      await checkReservation(tx);
      const { lead, contact, roots, leadReceipt, activityReceipt } = await load(tx);
      if (options.send) {
        // Fence the active worker lease immediately before the irreversible operation.
        await assertArtifactInputWriteFence(tx);
        invariant(await isArtifactInputProofPubliclyShareable(actor, workspaceId, roots, tx), 403, "SOURCE_RESTRICTED", "Recipient inputs are no longer public.");
        const originalRoots = structuredClone(roots);
        const controller = new AbortController();
        const controls: EmailAttemptControls = {
          signal: controller.signal,
          authorizeAttempt: async ({ signal }) => {
            try {
              controller.signal.throwIfAborted(); signal.throwIfAborted();
              await requireWorkspaceMembership({ actor, workspaceId, tx });
              await assertArtifactInputWriteFence(tx);
              invariant(await isArtifactInputProofPubliclyShareable(actor, workspaceId, originalRoots, tx),
                403, "SOURCE_RESTRICTED", "Original follow-up inputs are no longer public.");
              controller.signal.throwIfAborted(); signal.throwIfAborted();
            } catch (error) { controller.abort(error); throw error; }
          },
        };
        let delivery: EmailSendResult | undefined;
        try {
          delivery = await options.send(lead.email, options.operationId!, controls);
        } catch (error) {
          // Authorization/lease loss must still roll back. Never certify an outcome
          // from a wrapper that swallowed a failed dispatch guard.
          controller.signal.throwIfAborted();
          observedOutcome = error instanceof EmailSendError && error.outcome === "FAILED"
            ? { status: "FAILED", reason: "PROVIDER_REJECTED", providerCode: error.providerCode }
            : { status: "UNKNOWN", reason: "PROVIDER_RESPONSE_UNCERTAIN" };
          sendFailure = { error };
        }
        controller.signal.throwIfAborted();
        if (delivery?.status === "SKIPPED") {
          observedOutcome = delivery;
          sendFailure = { error: new AppError(409, "DELIVERY_SKIPPED", "Email was skipped; inspect its receipt before retrying.") };
        } else if (delivery?.status === "SENT" && delivery.providerMessageId) {
          observedOutcome = { status: "PROVIDER_ACCEPTED", providerMessageId: delivery.providerMessageId, followUpRecorded: false };
        } else if (!sendFailure) {
          observedOutcome = { status: "UNKNOWN", reason: "MISSING_PROVIDER_MESSAGE_ID" };
          sendFailure = { error: new AppError(409, "DELIVERY_UNCERTAIN", "Email acceptance is uncertain; inspect its receipt before retrying.") };
        }
        if (observedOutcome && observedOutcome.status !== "PROVIDER_ACCEPTED") {
          await writeOutcome(tx, observedOutcome, activityReceipt);
          return { operationId: options.operationId ?? null, delivery: observedOutcome };
        }
      }
      if (!await currentArtifactInputRoots(tx, workspaceId, { kind: "DemoLead", id: demoLeadId }, lead)) {
        await preserveUnknownArtifactInputSnapshot(tx, workspaceId, { kind: "DemoLead", id: demoLeadId }, lead);
      }
      const updatedLead = await tx.demoLead.update({ where: { id: demoLeadId }, data: {
        followUpCount: { increment: 1 }, lastFollowUpAt: new Date(),
      } });
      await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "DemoLead", id: demoLeadId }, content: updatedLead, receipt: leadReceipt });
      const recordedOutcome = observedOutcome?.status === "PROVIDER_ACCEPTED"
        ? { ...observedOutcome, followUpRecorded: true } : null;
      if (recordedOutcome) {
        await writeOutcome(tx, recordedOutcome, activityReceipt);
      } else {
        const activity = await tx.crmActivity.create({ data: { workspaceId, accountId: contact?.accountId ?? null, type: "EMAIL",
          contactId: contact?.id ?? null, title: `Sent follow-up #${lead.followUpCount + 1}`, bodyMd: emailContent } });
        await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmActivity", id: activity.id }, content: activity, receipt: activityReceipt });
      }
      return { operationId: options.operationId ?? null, delivery: recordedOutcome };
    });
  } catch (error) {
    if (reservation && observedOutcome) {
      // A failed accounting transaction must not discard an observed provider
      // receipt. Recover only an unchanged reservation under the same current
      // membership, source and worker fences; this never sends or advances count.
      try {
        await prisma.$transaction(async tx => {
          await checkReservation(tx);
          const { activityReceipt } = await load(tx);
          await writeOutcome(tx, observedOutcome!, activityReceipt);
        });
      } catch {
        // If storage or authority is still unavailable, the original durable
        // RESERVED row remains the fail-closed recovery marker. Preserve error.
      }
    }
    throw error;
  }
  // Non-success receipts must commit before reporting the original failure.
  if (sendFailure) throw sendFailure.error;
  return result;
}
