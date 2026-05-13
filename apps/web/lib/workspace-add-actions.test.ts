import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_FEATURE_FLAGS } from "@/lib/workspace-feature-flags";
import {
  getWorkspaceAddActions,
  sanitizeWorkspaceReturnTo,
  workspaceSubpath,
  type WorkspaceAddActionContext,
} from "./workspace-add-actions";

function context(overrides: Partial<WorkspaceAddActionContext> = {}): WorkspaceAddActionContext {
  return {
    workspaceId: "ws-1",
    pathname: "/workspaces/ws-1",
    featureFlags: DEFAULT_WORKSPACE_FEATURE_FLAGS,
    role: "ADMIN",
    invitePolicy: "MEMBERS_CAN_INVITE",
    meetingRecorderEnabled: false,
    isDemo: false,
    ...overrides,
  };
}

function kinds(overrides: Partial<WorkspaceAddActionContext>) {
  return getWorkspaceAddActions(context(overrides)).map((action) => action.kind);
}

describe("workspace add actions", () => {
  it("resolves workspace subpaths with optional locale prefixes", () => {
    expect(workspaceSubpath("/workspaces/ws-1/meetings", "ws-1")).toBe("/meetings");
    expect(workspaceSubpath("/en/workspaces/ws-1/settings", "ws-1")).toBe("/settings");
  });

  it("returns ordered meeting actions", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/meetings" })).toEqual([
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
    ]);
  });

  it("adds manual recording last for recorder-enabled meeting managers", () => {
    const recorderActions = [
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
      "meeting_manual_recording",
    ];
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true })).toEqual(recorderActions);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true, role: "FACILITATOR" })).toEqual(recorderActions);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true, role: "CONTRIBUTOR" })).toEqual([
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
    ]);
  });

  it("returns direct single-item actions on core list pages", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/actions" })).toEqual(["action"]);
    expect(kinds({ pathname: "/workspaces/ws-1/tensions" })).toEqual(["tension"]);
    expect(kinds({ pathname: "/workspaces/ws-1/proposals" })).toEqual(["proposal"]);
  });

  it("respects feature flags and demo read-only state", () => {
    expect(kinds({
      pathname: "/workspaces/ws-1/goals",
      featureFlags: { ...DEFAULT_WORKSPACE_FEATURE_FLAGS, GOALS: false },
    })).toEqual([]);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", isDemo: true })).toEqual([]);
  });

  it("uses tab and view context for multi-surface pages", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/finance", searchParams: "tab=accounts" })).toEqual([
      "spend",
      "ledger_account",
    ]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads", searchParams: "view=pipeline" })).toEqual(["deal"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads", searchParams: "view=instances" })).toEqual(["prospect_instance"]);
  });

  it("filters settings actions by role and invite policy", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/settings", searchParams: "tab=members", role: "ADMIN" })).toEqual([
      "member_invite",
      "member_bulk_invite",
    ]);
    expect(kinds({
      pathname: "/workspaces/ws-1/settings",
      searchParams: "tab=members",
      role: "CONTRIBUTOR",
      invitePolicy: "MEMBERS_CAN_REQUEST",
    })).toEqual(["member_invite"]);
    expect(kinds({
      pathname: "/workspaces/ws-1/settings",
      searchParams: "tab=general",
      role: "CONTRIBUTOR",
    })).toEqual([]);
  });
});

describe("sanitizeWorkspaceReturnTo", () => {
  it("allows same-workspace paths and query params", () => {
    expect(sanitizeWorkspaceReturnTo("ws-1", "/workspaces/ws-1/meetings?status=open")).toBe("/workspaces/ws-1/meetings?status=open");
    expect(sanitizeWorkspaceReturnTo("ws-1", "/en/workspaces/ws-1/settings?tab=members")).toBe("/en/workspaces/ws-1/settings?tab=members");
  });

  it("rejects external and cross-workspace returns", () => {
    expect(sanitizeWorkspaceReturnTo("ws-1", "https://example.com/workspaces/ws-1")).toBe("/workspaces/ws-1");
    expect(sanitizeWorkspaceReturnTo("ws-1", "/workspaces/ws-2/meetings")).toBe("/workspaces/ws-1");
    expect(sanitizeWorkspaceReturnTo("ws-1", "/admin/workspaces/ws-1")).toBe("/workspaces/ws-1");
  });
});
