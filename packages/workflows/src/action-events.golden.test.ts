import { describe, expect, it, vi } from "vitest";
vi.mock("@corgtex/domain", async () => import("../../domain/src/source-lineage-rebuild"));
import { deriveJobsForEvent } from "./derive-jobs";
import { deriveNotificationsForEvent } from "./derive-notifications";

const base = { id: "event-1", workspaceId: "workspace-1", aggregateType: "Action", aggregateId: "action-1", createdAt: new Date("2026-11-05T06:02:00Z") };
const syncJobs = [
  { workspaceId: base.workspaceId, eventId: base.id, type: "knowledge.sync.action", payload: { actionId: "action-1" }, dedupeKey: "event-1:action-knowledge-sync" },
  { workspaceId: base.workspaceId, eventId: base.id, type: "context-graph.sync", payload: { sourceType: "ACTION", sourceId: "action-1" }, dedupeKey: "event-1:context-graph-sync:ACTION:action-1", dependsOnDedupeKey: "event-1:action-knowledge-sync" },
];
const triage = { workspaceId: base.workspaceId, eventId: base.id, type: "agent.inbox-triage", payload: { eventType: "action.created", bucketStart: "2026-11-05T06:00:00.000Z", replayOfEventId: null }, dedupeKey: "workspace-1:triage:2026-11-05T06:00:00.000Z" };

describe("ordinary action event characterization", () => {
  it.each([undefined, 1])("preserves canonical outputs at eventVersion %s", (eventVersion) => {
    const version = eventVersion === undefined ? {} : { eventVersion };
    const created = { ...base, type: "action.created", payload: { actionId: "action-1", title: "Synthetic action", ...version } };
    const updated = { ...base, type: "action.updated", payload: { actionId: "action-1", fields: ["title"], evidenceDocumentIds: [], ...version } };
    expect(deriveJobsForEvent(created)).toEqual([...syncJobs, triage]);
    expect(deriveJobsForEvent(updated)).toEqual(syncJobs);
    expect(deriveNotificationsForEvent(created)).toEqual([]);
    expect(deriveNotificationsForEvent(updated)).toEqual([]);
  });
  it("retains replay triage identifiers and sync behavior", () => {
    const event = { ...base, type: "action.created", payload: { actionId: "action-1", title: "Synthetic", runtimeMeta: { replayOfEventId: "original-1" } } };
    expect(deriveJobsForEvent(event)).toEqual([...syncJobs, { ...triage, payload: { ...triage.payload, replayOfEventId: "original-1" }, dedupeKey: "workspace-1:triage:replay:event-1" }]);
    expect(deriveNotificationsForEvent(event)).toEqual([]);
  });
  it("retains the distinct Slack command envelope as triage only", () => {
    expect(deriveJobsForEvent({ ...base, aggregateId: null, type: "action.created", payload: { title: "Synthetic", bodyMd: "Filed via Slack", slackChannel: "C1", slackUser: "U1", source: "slack", inboundWebhookId: "inbound-1" } })).toEqual([triage]);
  });
  it.each([
    { actionId: 123, title: "Synthetic" },
    { actionId: "action-1", title: "Synthetic", eventVersion: 2 },
    { actionId: "action-1", title: "Synthetic", eventVersion: "1" },
  ])("does not derive ordinary jobs from invalid or unsupported pilot payloads %j", (payload) => {
    expect(deriveJobsForEvent({ ...base, type: "action.created", payload })).toEqual([]);
  });
  it("keeps publication notifications separate from creation", () => {
    expect(deriveNotificationsForEvent({ ...base, type: "action.published", payload: { title: " Synthetic ", actionId: "action-1", actorUserId: null, assigneeMemberId: null } })).toEqual([
      { type: "action.created", entityType: "Action", entityId: "action-1", title: "New action: Synthetic", bodyMd: "An action item was added to the workspace." },
    ]);
  });
});
