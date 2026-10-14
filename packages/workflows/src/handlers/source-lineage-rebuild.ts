import { prisma } from "@corgtex/shared";
import { invariant, isSourceLineageRebuildEvent, planSourceLineageRebuild } from "@corgtex/domain";
import { enqueueJob } from "../outbox";

/** Reload the immutable event identity from this workspace, rather than trusting
 * a queued payload's dates, source text, or proposed permission claims. */
export async function handleSourceLineageRebuild(
  _jobId: string,
  payload: { eventId?: string },
  workspaceId: string,
) {
  invariant(typeof payload.eventId === "string" && payload.eventId.length > 0, 400, "INVALID_INPUT", "A lineage change event is required.");
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findFirst({
      where: { id: payload.eventId, workspaceId },
      select: { id: true, workspaceId: true, type: true, createdAt: true },
    });
    invariant(event && isSourceLineageRebuildEvent(event.type), 404, "NOT_FOUND", "Lineage change event not found.");
    const recipes = planSourceLineageRebuild(event);
    for (const recipe of recipes) await enqueueJob(tx, recipe);
    return { enqueued: recipes.length };
  });
}
