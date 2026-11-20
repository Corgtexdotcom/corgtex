import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceOperation } from "./agent-operation-authorization";
import { requireCollaborativeWorkItemEditor } from "./collaborative-permissions";
import { requireDraftManager } from "./draft-permissions";
import { invariant } from "./errors";

/** References and evidence attachment do not transition an Action to completion. */
export async function requireActionAttachmentTarget(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  tx?: Prisma.TransactionClient;
}) {
  const membership = await requireWorkspaceOperation({ operation: "update_action", actor,
    workspaceId: params.workspaceId, tx: params.tx });
  const action = await (params.tx ?? prisma).action.findUnique({ where: { id: params.actionId } });
  invariant(action && action.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Action not found.");
  invariant(!action.archivedAt && !action.duplicateOfActionId, 400, "INVALID_STATE", "Archived or resolved duplicate actions cannot accept attachments.");
  if (action.status === "DRAFT") {
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: action, tx: params.tx });
  } else {
    invariant(action.status === "OPEN" || action.status === "IN_PROGRESS", 400, "INVALID_STATE", "This action cannot accept attachments.");
    requireCollaborativeWorkItemEditor(actor, membership, action);
  }
  return action;
}
