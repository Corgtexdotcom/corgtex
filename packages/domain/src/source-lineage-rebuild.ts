import type { Prisma } from "@prisma/client";

// Generated artifact updates are deliberately excluded: rebuild outputs must not
// recursively schedule another synthesis. Permission writers emit changed.
const REBUILD_EVENTS = new Set([
  "source-lineage.changed", "source-permission.changed", "brain-source.created", "document.updated", "meeting.processed-content-updated",
  "member.created", "member.updated", "member.deactivated", "member.reactivated",
  "role.assigned", "role.unassigned", "role.assignment.updated",
]);

export function isSourceLineageRebuildEvent(type: string) {
  return REBUILD_EVENTS.has(type);
}

export type SourceLineageRebuildEvent = {
  id: string;
  workspaceId: string | null;
  type: string;
  createdAt: Date;
};

/** Recipes describe fresh producer runs; they carry no prior artifact content or
 * permission grants. Producers resolve and prove their current input audience.
 * Old originals, approvals, and historical receipts remain untouched. */
export function planSourceLineageRebuild(event: SourceLineageRebuildEvent) {
  if (!event.workspaceId || !isSourceLineageRebuildEvent(event.type)) return [];
  const workspaceId = event.workspaceId;
  const recipes: Array<{ type: string; key: string; payload: Prisma.InputJsonObject }> = [
    { type: "agent.company-understanding", key: "company-understanding",
      payload: { sourceId: null, triggerType: "EVENT", rebuildRef: event.id } },
    { type: "context-graph.reconcile", key: "native-graph",
      payload: { dateISO: `rebuild:${event.id}` } },
    ...(["DAILY", "WEEKLY"] as const).map((cadence) => ({
      type: "brain.daily-digest", key: `briefing:${cadence}`,
      payload: { regenerationOnly: true, rebuildRef: event.id, dateISO: event.createdAt.toISOString(), cadence },
    })),
  ];
  return recipes.map((recipe) => ({
    workspaceId, eventId: event.id, type: recipe.type, payload: recipe.payload,
    dedupeKey: `${workspaceId}:source-lineage-rebuild:${event.id}:${recipe.key}`,
  }));
}
