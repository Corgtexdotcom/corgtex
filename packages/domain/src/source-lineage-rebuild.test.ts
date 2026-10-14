import { describe, expect, it } from "vitest";
import { isSourceLineageRebuildEvent, planSourceLineageRebuild } from "./source-lineage-rebuild";

const event = { id: "change-1", workspaceId: "ws-1", type: "source-lineage.changed", createdAt: new Date("2026-10-12T10:00:00Z") };
describe("source lineage rebuild recipes", () => {
  it("rebuilds fresh workspace synthesis, native graph, and both briefing cadences without old content", () => {
    const recipes = planSourceLineageRebuild({ ...event, ...{ payload: { oldBody: "unsafe", sourceId: "removed-source" } } });
    expect(recipes).toHaveLength(4);
    expect(recipes).toContainEqual(expect.objectContaining({ type: "agent.company-understanding", payload: { sourceId: null, triggerType: "EVENT", rebuildRef: event.id } }));
    expect(recipes).toContainEqual(expect.objectContaining({ type: "context-graph.reconcile", payload: { dateISO: "rebuild:change-1" } }));
    for (const cadence of ["DAILY", "WEEKLY"]) expect(recipes).toContainEqual(expect.objectContaining({
      type: "brain.daily-digest", payload: { regenerationOnly: true, rebuildRef: event.id, dateISO: event.createdAt.toISOString(), cadence },
    }));
    expect(JSON.stringify(recipes)).not.toContain("unsafe");
    expect(JSON.stringify(recipes)).not.toContain("removed-source");
    expect(recipes.every((recipe) => recipe.workspaceId === event.workspaceId && recipe.eventId === event.id)).toBe(true);
  });

  it("uses stable event-scoped identity while a second change on the same day gets fresh jobs", () => {
    const first = planSourceLineageRebuild(event);
    expect(planSourceLineageRebuild(event)).toEqual(first);
    const second = planSourceLineageRebuild({ ...event, id: "change-2" });
    expect(second.every((recipe) => !first.some((old) => old.dedupeKey === recipe.dedupeKey))).toBe(true);
    expect(second.find((recipe) => recipe.type === "context-graph.reconcile")?.payload.dateISO).not.toBe(first[1].payload.dateISO);
  });

  it("covers actual membership and assignment access events", () => {
    for (const type of ["member.created", "member.updated", "member.deactivated", "member.reactivated", "role.assigned", "role.unassigned", "role.assignment.updated", "brain-source.created"]) {
      expect(isSourceLineageRebuildEvent(type)).toBe(true);
      expect(planSourceLineageRebuild({ ...event, type })).toHaveLength(4);
    }
  });

  it("does not recursively rebuild generated artifact events or unscoped changes", () => {
    for (const type of ["brain-article.updated", "goal.created", "proposal.created", "context-graph.diff.created", "workspace-briefing.updated"]) {
      expect(planSourceLineageRebuild({ ...event, type })).toEqual([]);
    }
    expect(planSourceLineageRebuild({ ...event, workspaceId: null })).toEqual([]);
  });
});
