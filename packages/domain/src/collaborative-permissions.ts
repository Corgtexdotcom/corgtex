import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { AppError } from "./errors";

const TOOL_CREDENTIAL_MANAGER_ROLES = new Set(["ADMIN", "FACILITATOR"]);

type WorkItemRecord = {
  archivedAt?: Date | null;
  isPrivate?: boolean | null;
};

type AuthoredRecord = {
  authorUserId?: string | null;
};

type ToolLinkRecord = {
  createdByUserId?: string | null;
};

export function isActiveWorkspaceCollaborator(actor: AppActor, membership: MembershipSummary | null | undefined) {
  return actor.kind === "agent" || Boolean(membership?.isActive);
}

export function canEditPrivateDraft(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord & AuthoredRecord,
) {
  if (actor.kind === "agent") return true;
  if (!membership?.isActive) return false;
  if (membership.role === "ADMIN") return true;
  return Boolean(record.authorUserId && record.authorUserId === actor.user.id);
}

export function requirePrivateDraftEditor(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord & AuthoredRecord,
) {
  if (canEditPrivateDraft(actor, membership, record)) return;
  throw new AppError(403, "FORBIDDEN", "Only the draft creator, workspace admins, or agents can manage this draft.");
}

export function canEditCollaborativeWorkItem(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord,
) {
  return !record.archivedAt && record.isPrivate !== true && isActiveWorkspaceCollaborator(actor, membership);
}

export function requireCollaborativeWorkItemEditor(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord,
) {
  if (canEditCollaborativeWorkItem(actor, membership, record)) return;
  throw new AppError(403, "FORBIDDEN", "Any active workspace member can edit public open work items.");
}

export function canEditProposalContent(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord & AuthoredRecord,
) {
  if (actor.kind === "agent") return true;
  if (!membership?.isActive) return false;
  if (membership.role === "ADMIN") return true;
  return Boolean(record.authorUserId && record.authorUserId === actor.user.id);
}

export function requireProposalContentEditor(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: WorkItemRecord & AuthoredRecord,
) {
  if (canEditProposalContent(actor, membership, record)) return;
  throw new AppError(403, "FORBIDDEN", "Only the proposal author, workspace admins, or agents can edit proposals.");
}

export function canEditToolLinkMetadata(actor: AppActor, membership: MembershipSummary | null | undefined) {
  return isActiveWorkspaceCollaborator(actor, membership);
}

export function requireToolLinkMetadataEditor(actor: AppActor, membership: MembershipSummary | null | undefined) {
  if (canEditToolLinkMetadata(actor, membership)) return;
  throw new AppError(403, "FORBIDDEN", "Any active workspace member can edit tool link metadata.");
}

export function canManageToolLinkCredential(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  link: ToolLinkRecord,
) {
  if (actor.kind === "agent") return true;
  if (!membership?.isActive) return false;
  if (TOOL_CREDENTIAL_MANAGER_ROLES.has(membership.role)) return true;
  return Boolean(link.createdByUserId && link.createdByUserId === actor.user.id);
}

export function requireToolLinkCredentialManager(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  link: ToolLinkRecord,
) {
  if (canManageToolLinkCredential(actor, membership, link)) return;
  throw new AppError(403, "FORBIDDEN", "Only the creator, facilitators, admins, or agents can manage tool credentials.");
}

export function canEditMeetingProcessedContent(actor: AppActor, membership: MembershipSummary | null | undefined) {
  return isActiveWorkspaceCollaborator(actor, membership);
}

export function requireMeetingProcessedContentEditor(actor: AppActor, membership: MembershipSummary | null | undefined) {
  if (canEditMeetingProcessedContent(actor, membership)) return;
  throw new AppError(403, "FORBIDDEN", "Any active workspace member can edit meeting summaries and guidance.");
}
