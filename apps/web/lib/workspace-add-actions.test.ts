import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_FEATURE_FLAGS } from "@/lib/workspace-feature-flags";
import {
  crmAccountIdFromPath,
  getMobileCaptureActions,
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

  it("extracts relationship account detail context from workspace paths", () => {
    expect(crmAccountIdFromPath("/workspaces/ws-1/leads/accounts/account-1", "ws-1")).toBe("account-1");
    expect(crmAccountIdFromPath("/en/workspaces/ws-1/leads/accounts/account%202?view=pipeline", "ws-1")).toBe("account 2");
    expect(crmAccountIdFromPath("/workspaces/ws-1/leads/accounts", "ws-1")).toBeNull();
    expect(crmAccountIdFromPath("/workspaces/ws-2/leads/accounts/account-1", "ws-1")).toBeNull();
  });

  it("returns ordered meeting actions", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/meetings" })).toEqual([
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
      "meeting_audio_upload",
    ]);
  });

  it("adds manual recording last for recorder-enabled meeting managers", () => {
    const recorderActions = [
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
      "meeting_audio_upload",
      "meeting_manual_recording",
    ];
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true })).toEqual(recorderActions);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true, role: "FACILITATOR" })).toEqual(recorderActions);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", meetingRecorderEnabled: true, role: "CONTRIBUTOR" })).toEqual([
      "meeting_schedule",
      "meeting_invite",
      "meeting_transcript",
      "meeting_audio_upload",
    ]);
  });

  it("returns direct single-item actions on core list pages", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/actions" })).toEqual(["action"]);
    expect(kinds({ pathname: "/workspaces/ws-1/tensions" })).toEqual(["tension"]);
    expect(kinds({ pathname: "/workspaces/ws-1/proposals" })).toEqual(["proposal"]);
  });

  it("offers proposal and Brain article creation from Agreements", () => {
    const agreementsActions = getWorkspaceAddActions(context({ pathname: "/workspaces/ws-1/agreements" }));
    expect(agreementsActions.map((action) => action.kind)).toEqual(["proposal", "article"]);
    expect(agreementsActions[1]).toMatchObject({
      kind: "article",
      label: "Working agreement",
      description: "Capture a working agreement with source and context.",
    });
    expect(kinds({ pathname: "/workspaces/ws-1/agreements", isDemo: true })).toEqual([]);
  });

  it("hides the global action add shortcut on action detail and edit routes", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/actions/action-1" })).toEqual([]);
    expect(kinds({ pathname: "/workspaces/ws-1/actions/action-1/edit" })).toEqual([]);
  });

  it("offers goal creation plus evidence capture from Goals", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/goals" })).toEqual([
      "goal",
      "generate_goals_from_brain",
      "upload_file",
      "paste_text",
    ]);
    expect(kinds({ pathname: "/workspaces/ws-1/goals", role: "CONTRIBUTOR" })).toEqual([
      "goal",
      "upload_file",
      "paste_text",
    ]);
  });

  it("offers Brain upload before article creation", () => {
    const brainActions = getWorkspaceAddActions(context({ pathname: "/workspaces/ws-1/brain" }));
    expect(brainActions.map((action) => action.kind)).toEqual(["upload_file", "article"]);
    expect(brainActions[1]).toMatchObject({
      kind: "article",
      label: "Brain article",
    });
  });

  it("uses circle detail context for structure actions", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/circles" })).toEqual(["circle", "role"]);
    expect(kinds({ pathname: "/workspaces/ws-1/circles/circle-1" })).toEqual([
      "circle",
      "role",
      "role_assignment",
    ]);
    expect(kinds({ pathname: "/workspaces/ws-1/circles/circle-1", role: "CONTRIBUTOR" })).toEqual([]);
  });

  it("respects feature flags and demo read-only state", () => {
    expect(kinds({
      pathname: "/workspaces/ws-1/goals",
      featureFlags: { ...DEFAULT_WORKSPACE_FEATURE_FLAGS, GOALS: false },
    })).toEqual([]);
    expect(kinds({ pathname: "/workspaces/ws-1/meetings", isDemo: true })).toEqual([]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", isDemo: true })).toEqual([]);
    expect(kinds({
      pathname: "/workspaces/ws-1/finance",
      featureFlags: { ...DEFAULT_WORKSPACE_FEATURE_FLAGS, FINANCE: false },
    })).toEqual([]);
    expect(kinds({
      pathname: "/workspaces/ws-1/finance",
      featureFlags: { ...DEFAULT_WORKSPACE_FEATURE_FLAGS, FINANCE: true, PRACTICE_PROJECTS: false },
    })).toEqual([]);
  });

  it("uses tab and view context for multi-surface pages", () => {
    const financeFlags = { ...DEFAULT_WORKSPACE_FEATURE_FLAGS, FINANCE: true, PRACTICE_PROJECTS: true };
    expect(kinds({ pathname: "/workspaces/ws-1/finance" })).toEqual([]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", featureFlags: financeFlags })).toEqual(["finance_project"]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", featureFlags: financeFlags, role: "FINANCE_STEWARD" })).toEqual(["finance_project"]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", featureFlags: financeFlags, role: "FACILITATOR" })).toEqual(["finance_project"]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", featureFlags: financeFlags, role: "CONTRIBUTOR" })).toEqual(["finance_project"]);
    expect(kinds({ pathname: "/workspaces/ws-1/finance", featureFlags: financeFlags, searchParams: "tab=accounts" })).toEqual(["finance_project"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads" })).toEqual([
      "crm_account",
      "contact",
      "deal",
      "crm_activity",
      "communication_suggestion",
    ]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads", searchParams: "view=pipeline" })).toEqual(["deal"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads", searchParams: "view=instances" })).toEqual(["prospect_instance"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts" })).toEqual(["crm_account"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/pipeline" })).toEqual(["deal"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/activity" })).toEqual(["crm_activity"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/suggestions" })).toEqual(["communication_suggestion"]);
  });

  it("narrows relationship account detail add actions by active tab", () => {
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1" })).toEqual([
      "contact",
      "deal",
      "crm_activity",
      "communication_suggestion",
    ]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1", searchParams: "view=contacts" })).toEqual(["contact"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1", searchParams: "view=pipeline" })).toEqual(["deal"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1", searchParams: "view=activity" })).toEqual(["crm_activity"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1", searchParams: "view=suggestions" })).toEqual(["communication_suggestion"]);
    expect(kinds({ pathname: "/workspaces/ws-1/leads/accounts/account-1", searchParams: "view=instances" })).toEqual([]);
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

  it("selects mobile capture actions through the same Add page rules", () => {
    const captureActions = getMobileCaptureActions(context());

    expect(captureActions.map((action) => action.kind)).toEqual([
      "upload_file",
      "paste_text",
      "tension",
      "action",
      "meeting_transcript",
      "meeting_audio_upload",
    ]);
    expect(captureActions[0]).toMatchObject({
      kind: "upload_file",
      label: "Upload files from this device",
      description: "Choose files or folders from this phone or computer.",
    });
    expect(captureActions[0]?.href).toBe(
      "/workspaces/ws-1/add?kind=upload_file&returnTo=%2Fworkspaces%2Fws-1%2Fbrain",
    );
    expect(captureActions[1]?.href).toBe(
      "/workspaces/ws-1/add?kind=paste_text&returnTo=%2Fworkspaces%2Fws-1%2Fsettings%3Ftab%3Ddata-sources",
    );
  });

  it("adds mobile manual recording only when recorder permissions allow it", () => {
    expect(getMobileCaptureActions(context({ meetingRecorderEnabled: true })).map((action) => action.kind)).toContain(
      "meeting_manual_recording",
    );
    expect(getMobileCaptureActions(context({ meetingRecorderEnabled: true, role: "CONTRIBUTOR" })).map((action) => action.kind)).not.toContain(
      "meeting_manual_recording",
    );
  });

  it("hides mobile capture actions in demo workspaces", () => {
    expect(getMobileCaptureActions(context({ isDemo: true }))).toEqual([]);
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
