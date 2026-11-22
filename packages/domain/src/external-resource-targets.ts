import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireActionAttachmentTarget } from "./action-attachment-policy";
import { lockWorkspaceArchiveArtifact } from "./archive";
import { requireWorkspaceMembership } from "./auth";
import { requireCollaborativeWorkItemEditor, requireProposalContentEditor } from "./collaborative-permissions";
import { requireDraftManager } from "./draft-permissions";
import { invariant } from "./errors";
import type { WorkspaceExternalResourceEntityType } from "./external-resources";
import { assertArtifactInputWriteFence, readableArtifactIds, readableBrainSourceIds } from "./source-lineage";
import { lockSourceAuthorityRow } from "./source-commit-row-locks";

/** Lock the target before re-reading authority. Row locks also cover writers which
 * do not use the work-item/source advisory protocol (including member revocation).
 * The caller owns the transaction through resource, attachment, audit and job writes. */
export async function requireExternalResourceAttachmentTarget(tx: Prisma.TransactionClient, actor: AppActor, params: {
  workspaceId: string;
  entityType: WorkspaceExternalResourceEntityType;
  entityId: string;
}) {
  const { workspaceId, entityType, entityId } = params;
  await assertArtifactInputWriteFence(tx);
  await lockWorkspaceArchiveArtifact(tx, entityType, entityId);
  await lockSourceAuthorityRow(tx, entityType, entityId, workspaceId);
  if (actor.kind === "user") {
    await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${actor.user.id} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "WorkspaceSupportGrant" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${actor.user.id} FOR SHARE`;
  } else if (actor.credentialId) {
    await lockSourceAuthorityRow(tx, "AgentCredential", actor.credentialId, workspaceId);
  }
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  if (entityType === "Action") {
    const action = await requireActionAttachmentTarget(actor, { workspaceId, actionId: entityId, tx });
    invariant((await readableArtifactIds(actor, workspaceId, "Action", [action], tx)).has(entityId),
      404, "NOT_FOUND", "Action not found.");
  } else if (entityType === "Tension") {
    const tension = await tx.tension.findUnique({ where: { id: entityId } });
    invariant(tension && tension.workspaceId === workspaceId, 404, "NOT_FOUND", "Tension not found.");
    invariant(!tension.archivedAt, 400, "INVALID_STATE", "Archived tensions cannot accept attachments.");
    if (tension.status === "DRAFT") {
      await requireDraftManager({ actor, workspaceId, record: tension, tx });
    } else {
      invariant(tension.status === "OPEN", 400, "INVALID_STATE", "Only draft or open tensions can accept attachments.");
      requireCollaborativeWorkItemEditor(actor, membership, tension);
    }
    invariant((await readableArtifactIds(actor, workspaceId, "Tension", [tension], tx)).has(entityId),
      404, "NOT_FOUND", "Tension not found.");
  } else if (entityType === "Proposal") {
    const proposal = await tx.proposal.findUnique({ where: { id: entityId } });
    invariant(proposal && proposal.workspaceId === workspaceId, 404, "NOT_FOUND", "Proposal not found.");
    // Match updateProposal's author/admin/agent rule, rather than Action collaboration.
    invariant(!proposal.archivedAt && ["DRAFT", "OPEN"].includes(proposal.status),
      400, "INVALID_STATE", "Only draft or open proposals can accept attachments.");
    requireProposalContentEditor(actor, membership, proposal);
    invariant((await readableArtifactIds(actor, workspaceId, "Proposal", [proposal], tx)).has(entityId),
      404, "NOT_FOUND", "Proposal not found.");
  } else if (entityType === "Meeting") {
    // Like meeting content writers: current collaborators and an active readable
    // meeting. Attachment does not edit a transcript or processing output.
    const meeting = await tx.meeting.findFirst({ where: { id: entityId, workspaceId, archivedAt: null } });
    invariant(meeting && (await readableArtifactIds(actor, workspaceId, "Meeting", [meeting], tx)).has(entityId),
      404, "NOT_FOUND", "Meeting not found.");
  } else {
    // Match source removal admission: active membership plus domain and lineage
    // readability; neither absorption nor knowledge access grants draft authority.
    const source = await tx.brainSource.findFirst({ where: { id: entityId, workspaceId, archivedAt: null } });
    invariant(source && (await readableBrainSourceIds(actor, workspaceId, [source], tx)).has(entityId),
      404, "NOT_FOUND", "Source not found.");
  }
}
