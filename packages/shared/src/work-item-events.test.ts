import { describe, expect, it } from "vitest";
import { createActionEvent, decodeActionEvent, isObjectRecord, isReplayEvent, readPayloadString } from "./work-item-events";

describe("persisted ordinary action contract", () => {
  it.each([
    ["action.created", { actionId: "a1", title: "Synthetic" }],
    ["action.updated", { actionId: "a1", fields: ["status", "completedVia"] }],
    ["action.updated", { actionId: "a1", fields: ["bodyMd"] }],
    ["action.updated", { actionId: "a1", fields: ["title"], evidenceDocumentIds: ["d1"] }],
  ])("decodes actual legacy %s shapes and version one", (type, payload) => {
    expect(decodeActionEvent({ type, payload })).toMatchObject({ status: "legacy", event: { type, payload } });
    expect(decodeActionEvent({ type, payload: { ...payload, eventVersion: 1 } })).toMatchObject({ status: "supported", event: { type, payload: { ...payload, eventVersion: 1 } } });
  });
  it("retains earlier sparse legacy payloads without upgrading them", () => {
    expect(decodeActionEvent({ type: "action.created", payload: { actionId: "a1" } })).toMatchObject({ status: "legacy" });
    expect(decodeActionEvent({ type: "action.updated", payload: { actionId: "a1" } })).toMatchObject({ status: "legacy" });
    for (const type of ["action.created", "action.updated"]) {
      expect(decodeActionEvent({ type, payload: { actionId: "a1", eventVersion: 1 } }).status).toBe("invalid");
    }
  });
  it.each([
    null, [], {}, { actionId: 123, title: "T" }, { actionId: "a1", title: 123 },
    { actionId: "a1", title: "T", eventVersion: "1" }, { actionId: "a1", title: "T", eventVersion: null },
  ])("rejects malformed creation payload %j", (payload) => {
    expect(decodeActionEvent({ type: "action.created", payload }).status).toBe("invalid");
  });
  it.each([{ fields: "title" }, { fields: [1] }, { evidenceDocumentIds: [null] }, { evidenceDocumentIds: "d1" }])("rejects malformed update fields %j", (fields) => {
    expect(decodeActionEvent({ type: "action.updated", payload: { actionId: "a1", ...fields } }).status).toBe("invalid");
  });
  it("separates unsupported versions from malformed payloads and unrelated families", () => {
    expect(decodeActionEvent({ type: "action.created", payload: { eventVersion: 2 } })).toEqual({ status: "unsupported-version", version: 2 });
    expect(decodeActionEvent({ type: "action.published", payload: { eventVersion: 2 } })).toEqual({ status: "unmigrated" });
    expect(decodeActionEvent({ type: "meeting.created", payload: null })).toEqual({ status: "unmigrated" });
  });
  it("recognizes only the persisted unversioned Slack command as a legacy command", () => {
    const payload = { title: "Synthetic", bodyMd: "Filed via Slack", slackChannel: "C1", slackUser: "U1", source: "slack", inboundWebhookId: "inbound-1" };
    expect(decodeActionEvent({ type: "action.created", aggregateId: null, payload }).status).toBe("legacy-command");
    expect(decodeActionEvent({ type: "action.created", aggregateId: "a1", payload }).status).toBe("invalid");
    expect(decodeActionEvent({ type: "action.created", payload: { ...payload, eventVersion: 1 } }).status).toBe("invalid");
  });
  it("constructs versioned payloads without moving the existing envelope fields", () => {
    const event = createActionEvent("action.created", { actionId: "a1", title: "Synthetic" }, "ws1");
    expect(event).toEqual({ workspaceId: "ws1", type: "action.created", aggregateType: "Action", aggregateId: "a1", payload: { actionId: "a1", title: "Synthetic", eventVersion: 1 } });
    expect(decodeActionEvent(event).status).toBe("supported");
  });
});

describe("shared metadata compatibility", () => {
  it.each([null, [], "title", 1, true])("ignores non-record metadata %j", (payload) => {
    expect(isObjectRecord(payload)).toBe(false);
    expect(readPayloadString(payload, "title")).toBeNull();
    expect(isReplayEvent(payload)).toBe(false);
  });
  it("trims nonempty text and preserves the existing replay interpretation", () => {
    expect(readPayloadString({ title: " Title " }, "title")).toBe("Title");
    for (const title of [" ", 1, null, {}, []]) expect(readPayloadString({ title }, "title")).toBeNull();
    for (const replayOfEventId of [" ", 1, null, {}, []]) expect(isReplayEvent({ runtimeMeta: { replayOfEventId } })).toBe(false);
    expect(isReplayEvent({ runtimeMeta: { replayOfEventId: " replay " } })).toBe(true);
    expect(isReplayEvent({ runtimeMeta: [] })).toBe(false);
  });
});
