import type { MemberRole } from "@prisma/client";

import type { WorkspaceFeatureFlagMap } from "@/lib/workspace-feature-flags";

export const WORKSPACE_ADD_ACTION_DEFINITIONS = {
  meeting_schedule: {
    label: "Schedule meeting",
    description: "Create a planned meeting or recurring meeting series.",
  },
  meeting_invite: {
    label: "Import calendar invite",
    description: "Upload an ICS calendar invite.",
  },
  meeting_transcript: {
    label: "Upload transcript",
    description: "Ingest a completed meeting transcript.",
  },
  meeting_manual_recording: {
    label: "Record meeting manually",
    description: "Schedule a recorder for a meeting link.",
  },
  action: {
    label: "Action",
    description: "Create a new action draft.",
  },
  tension: {
    label: "Tension",
    description: "Capture a new tension.",
  },
  proposal: {
    label: "Proposal",
    description: "Draft a governance proposal.",
  },
  goal: {
    label: "Goal",
    description: "Create a goal with optional key results.",
  },
  circle: {
    label: "Circle",
    description: "Create a workspace circle.",
  },
  role: {
    label: "Role",
    description: "Create a role in a circle.",
  },
  role_assignment: {
    label: "Member assignment",
    description: "Assign a member to a role in this circle.",
  },
  cycle: {
    label: "Cycle",
    description: "Create a contribution cycle.",
  },
  allocation: {
    label: "Allocation",
    description: "Allocate points in an open cycle.",
  },
  spend: {
    label: "Spend",
    description: "Create a spend request.",
  },
  ledger_account: {
    label: "Ledger account",
    description: "Create a finance account.",
  },
  article: {
    label: "Brain article",
    description: "Create a knowledge article.",
  },
  tool_app: {
    label: "Submit app",
    description: "Send an employee-made app to admins.",
  },
  tool_link: {
    label: "Publish shared link",
    description: "Add a shared workspace tool link.",
  },
  contact: {
    label: "Contact",
    description: "Create a relationship contact.",
  },
  deal: {
    label: "Deal",
    description: "Create a pipeline deal.",
  },
  prospect_instance: {
    label: "Provision instance",
    description: "Provision a prospect demo workspace.",
  },
  member_invite: {
    label: "Invite member",
    description: "Invite or request a member invitation.",
  },
  member_bulk_invite: {
    label: "Bulk invite",
    description: "Invite members from pasted CSV rows.",
  },
  webhook: {
    label: "Outbound webhook",
    description: "Create an outbound webhook endpoint.",
  },
  upload_file: {
    label: "Upload file",
    description: "Upload files into workspace knowledge.",
  },
  paste_text: {
    label: "Paste text",
    description: "Ingest pasted text or a transcript.",
  },
  database_source: {
    label: "Database source",
    description: "Connect an external Postgres source.",
  },
} as const;

export type WorkspaceAddActionKind = keyof typeof WORKSPACE_ADD_ACTION_DEFINITIONS;

export type WorkspaceAddAction = {
  kind: WorkspaceAddActionKind;
  label: string;
  description: string;
};

export type MobileCaptureAction = WorkspaceAddAction & {
  href: string;
};

export type WorkspaceAddInvitePolicy = "ADMINS_ONLY" | "MEMBERS_CAN_INVITE" | "MEMBERS_CAN_REQUEST";

type WorkspaceSearchParamsLike = {
  get(key: string): string | null;
  toString(): string;
};

export type WorkspaceAddActionContext = {
  workspaceId: string;
  pathname: string;
  searchParams?: WorkspaceSearchParamsLike | string | Record<string, string | string[] | undefined> | null;
  featureFlags: WorkspaceFeatureFlagMap;
  role?: MemberRole | null;
  invitePolicy?: WorkspaceAddInvitePolicy | null;
  meetingRecorderEnabled?: boolean;
  isDemo?: boolean;
};

const WORKSPACE_MARKER = "/workspaces/";

function action(kind: WorkspaceAddActionKind): WorkspaceAddAction {
  return {
    kind,
    ...WORKSPACE_ADD_ACTION_DEFINITIONS[kind],
  };
}

function searchParam(
  searchParams: WorkspaceAddActionContext["searchParams"],
  key: string,
) {
  if (!searchParams) return null;

  if (typeof searchParams === "string") {
    return new URLSearchParams(searchParams.startsWith("?") ? searchParams.slice(1) : searchParams).get(key);
  }

  if ("get" in searchParams && typeof searchParams.get === "function") {
    return searchParams.get(key);
  }

  const value = (searchParams as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function workspaceSubpath(pathname: string, workspaceId: string) {
  const marker = `${WORKSPACE_MARKER}${workspaceId}`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex === -1) return null;

  const afterWorkspace = pathname.slice(markerIndex + marker.length);
  if (!afterWorkspace || afterWorkspace === "/") return "";
  return afterWorkspace.startsWith("/") ? afterWorkspace : `/${afterWorkspace}`;
}

function primarySegment(subpath: string | null) {
  if (subpath === null) return null;
  return subpath.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean)[0] ?? "";
}

function isAdmin(role: MemberRole | null | undefined) {
  return role === "ADMIN";
}

function isStructureManager(role: MemberRole | null | undefined) {
  return role === "ADMIN" || role === "FACILITATOR";
}

function pathSegments(subpath: string | null) {
  if (subpath === null) return null;
  return subpath.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean) ?? [];
}

function canInviteMembers(context: WorkspaceAddActionContext) {
  return isAdmin(context.role) || context.invitePolicy === "MEMBERS_CAN_INVITE" || context.invitePolicy === "MEMBERS_CAN_REQUEST";
}

function canRecordMeetingsManually(context: WorkspaceAddActionContext) {
  return Boolean(context.meetingRecorderEnabled && (context.role === "ADMIN" || context.role === "FACILITATOR"));
}

const MOBILE_CAPTURE_SPECS: Array<{
  kind: WorkspaceAddActionKind;
  subpath: string;
}> = [
  { kind: "tension", subpath: "/tensions" },
  { kind: "action", subpath: "/actions" },
  { kind: "meeting_transcript", subpath: "/meetings" },
  { kind: "meeting_manual_recording", subpath: "/meetings" },
  { kind: "upload_file", subpath: "/brain" },
  { kind: "paste_text", subpath: "/settings?tab=data-sources" },
];

export function getWorkspaceAddActions(context: WorkspaceAddActionContext): WorkspaceAddAction[] {
  if (context.isDemo) return [];

  const subpath = workspaceSubpath(context.pathname, context.workspaceId);
  const segment = primarySegment(subpath);
  const segments = pathSegments(subpath);
  if (segment === null || segment === "add") return [];

  switch (segment) {
    case "meetings":
      return [
        action("meeting_schedule"),
        action("meeting_invite"),
        action("meeting_transcript"),
        ...(canRecordMeetingsManually(context) ? [action("meeting_manual_recording")] : []),
      ];
    case "actions":
      return [action("action")];
    case "tensions":
      return [action("tension")];
    case "proposals":
      return [action("proposal")];
    case "goals":
      return context.featureFlags.GOALS ? [action("goal")] : [];
    case "circles":
      if (!isStructureManager(context.role)) return [];
      return (segments?.length ?? 0) > 1
        ? [action("circle"), action("role"), action("role_assignment")]
        : [action("circle"), action("role")];
    case "cycles":
      return context.featureFlags.CYCLES ? [action("cycle"), action("allocation")] : [];
    case "finance":
      return [action("spend"), action("ledger_account")];
    case "brain":
      return [action("upload_file"), action("article")];
    case "tools":
      return context.featureFlags.TOOL_LINKS ? [action("tool_app"), action("tool_link")] : [];
    case "leads": {
      if (!context.featureFlags.RELATIONSHIPS) return [];
      const view = searchParam(context.searchParams, "view") ?? "contacts";
      if (view === "pipeline") return [action("deal")];
      if (view === "instances") return [action("prospect_instance")];
      if (view === "contacts") return [action("contact")];
      return [];
    }
    case "settings": {
      const tab = searchParam(context.searchParams, "tab") ?? (context.featureFlags.SETTINGS_GENERAL ? "general" : "members");
      if (tab === "members") {
        const actions = canInviteMembers(context) ? [action("member_invite")] : [];
        return isAdmin(context.role) ? [...actions, action("member_bulk_invite")] : actions;
      }
      if (tab === "general") {
        return context.featureFlags.SETTINGS_GENERAL && isAdmin(context.role) ? [action("webhook")] : [];
      }
      if (tab === "data-sources") {
        return isAdmin(context.role)
          ? [action("upload_file"), action("paste_text"), action("database_source")]
          : [action("upload_file"), action("paste_text")];
      }
      return [];
    }
    default:
      return [];
  }
}

export function getMobileCaptureActions(
  context: Omit<WorkspaceAddActionContext, "pathname" | "searchParams">,
): MobileCaptureAction[] {
  return MOBILE_CAPTURE_SPECS.flatMap((spec) => {
    const [path, query = ""] = spec.subpath.split("?");
    const pathname = `/workspaces/${context.workspaceId}${path}`;
    const returnTo = `${pathname}${query ? `?${query}` : ""}`;
    const actions = getWorkspaceAddActions({
      ...context,
      pathname,
      searchParams: query,
    });
    const action = actions.find((item) => item.kind === spec.kind);
    if (!action) return [];

    return [{
      ...action,
      href: `/workspaces/${context.workspaceId}/add?kind=${encodeURIComponent(action.kind)}&returnTo=${encodeURIComponent(returnTo)}`,
    }];
  });
}

export function isWorkspaceAddActionKind(value: unknown): value is WorkspaceAddActionKind {
  return typeof value === "string" && value in WORKSPACE_ADD_ACTION_DEFINITIONS;
}

export function sanitizeWorkspaceReturnTo(
  workspaceId: string,
  rawReturnTo: string | string[] | undefined,
  fallback = `/workspaces/${workspaceId}`,
) {
  const value = Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo;
  if (!value) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://app.local");
  } catch {
    return fallback;
  }

  if (parsed.origin !== "https://app.local") return fallback;

  const marker = `${WORKSPACE_MARKER}${workspaceId}`;
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex === -1) return fallback;

  const beforeMarker = parsed.pathname.slice(0, markerIndex);
  if (beforeMarker && !/^\/[a-z]{2}(?:-[A-Z]{2})?$/.test(beforeMarker)) return fallback;

  const pathAfterMarker = parsed.pathname.slice(markerIndex + marker.length);
  if (pathAfterMarker && !pathAfterMarker.startsWith("/")) return fallback;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
