import type { BrainArticleType, BrainSourceType, GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";
import { notFound, redirect } from "next/navigation";
import {
  createCatalogRequest,
  createExternalDataSource,
  createWorkspaceToolLink,
  getMeetingRecorderConfig,
  getMemberInvitePolicy,
  listCrmAccounts,
  listDeals,
  ingestSource,
  intakeMeetingTranscript,
  listCircles,
  listContacts,
  listCycles,
  listGoals,
  listHumanMembers,
  listProposals,
  listQualifications,
  listRoles,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { encrypt } from "@corgtex/connectors-sql";
import { prisma } from "@corgtex/shared";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { ActionEditorForm } from "@/lib/components/ActionEditorForm";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import {
  DEFAULT_MEETING_DURATION_MINUTES,
  MAX_MEETING_DURATION_MINUTES,
  MIN_MEETING_DURATION_MINUTES,
  parseOptionalMeetingDateTimeInput,
} from "@/lib/meeting-timezone";
import { KnowledgeFileUploader } from "../KnowledgeFileUploader";
import { ManualMeetingRecordingForm } from "./ManualMeetingRecordingForm";
import { MeetingAudioUploadForm } from "./MeetingAudioUploadForm";
import {
  crmAccountIdFromPath,
  getWorkspaceAddActions,
  isWorkspaceAddActionKind,
  sanitizeWorkspaceReturnTo,
  WORKSPACE_ADD_ACTION_DEFINITIONS,
  workspaceSubpath,
  type WorkspaceAddActionKind,
} from "@/lib/workspace-add-actions";
import {
  assignRoleAction,
  bulkInviteAction,
  createActionAction,
  createActivityAction,
  createAllocationAction,
  createCircleAction,
  createCommunicationSuggestionAction,
  createContactAction,
  createCrmAccountAction,
  createCycleAction,
  createDealAction,
  createMeetingSeriesAction,
  createMemberAction,
  createProposalAction,
  createRoleAction,
  createTensionAction,
  createWebhookEndpointAction,
  importMeetingInviteAction,
  inviteMemberAction,
  provisionProspectWorkspaceAction,
  requestMemberInviteAction,
  uploadMeetingTranscriptAction,
} from "../actions";
import { createArticleAction } from "../brain/actions";
import { createGoalFormAction, refreshCompanyDirectionFromBrainFormAction } from "../goals/actions";
import { asOptional, asOptionalInt, asString, refresh } from "../action-utils";
import {
  CRM_ACTIVITY_TYPES,
  CRM_CREATABLE_DEAL_STAGES,
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  labelFromCrmCode,
} from "../leads/view-model";

export const dynamic = "force-dynamic";

const CADENCES: { id: GoalCadence; label: string }[] = [
  { id: "TEN_YEAR", label: "10Y" },
  { id: "FIVE_YEAR", label: "5Y" },
  { id: "ANNUAL", label: "Annual" },
  { id: "QUARTERLY", label: "Quarterly" },
  { id: "MONTHLY", label: "Monthly" },
  { id: "WEEKLY", label: "Weekly" },
];

const GOAL_LEVELS: GoalLevel[] = ["COMPANY", "CIRCLE", "PERSONAL"];
const GOAL_STATUSES: GoalStatus[] = ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "DRAFT", "ABANDONED"];
const ARTICLE_TYPES: BrainArticleType[] = ["PRODUCT", "ARCHITECTURE", "PROCESS", "RUNBOOK", "DECISION", "TEAM", "PERSON", "CUSTOMER", "INCIDENT", "PROJECT", "INTEGRATION", "PATTERN", "STRATEGY", "CULTURE", "GLOSSARY"];
const SOURCE_TYPES: BrainSourceType[] = ["MEETING", "TICKET", "PR", "RFC", "INCIDENT", "SLACK", "CUSTOMER_FEEDBACK", "COMPETITOR", "RESEARCH", "ARTICLE", "DOC", "RUNBOOK", "EMAIL", "FILE_UPLOAD", "EXTERNAL_CONTENT"];

function splitList(value: string | null) {
  return (value ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function throwIfFailed(result: unknown) {
  if (
    result
    && typeof result === "object"
    && "success" in result
    && (result as { success?: boolean }).success === false
  ) {
    throw new Error(String((result as { error?: unknown }).error ?? "Action failed."));
  }
}

function hiddenWorkspace(workspaceId: string) {
  return <input type="hidden" name="workspaceId" value={workspaceId} />;
}

function cancelLink(returnTo: string) {
  return <a className="link-button secondary" href={returnTo}>Cancel</a>;
}

function firstSearchValue(search: Record<string, string | string[] | undefined>, key: string) {
  const value = search[key];
  return Array.isArray(value) ? value[0] : value;
}

function creatableDealStageFromSearch(search: Record<string, string | string[] | undefined>) {
  const value = firstSearchValue(search, "stage");
  return CRM_CREATABLE_DEAL_STAGES.includes(value as typeof CRM_CREATABLE_DEAL_STAGES[number])
    ? value as typeof CRM_CREATABLE_DEAL_STAGES[number]
    : null;
}

function circleIdFromReturnTo(returnTo: string, workspaceId: string) {
  const parsed = new URL(returnTo, "https://app.local");
  const subpath = workspaceSubpath(parsed.pathname, workspaceId);
  const segments = subpath?.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean) ?? [];
  if (segments[0] !== "circles" || !segments[1]) return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return segments[1];
  }
}

export default async function WorkspaceAddPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const search = searchParams ? await searchParams : {};
  const kindValue = Array.isArray(search.kind) ? search.kind[0] : search.kind;
  if (!isWorkspaceAddActionKind(kindValue)) notFound();
  const kind: WorkspaceAddActionKind = kindValue;

  const actor = await requirePageActor();
  const [featureFlags, membership, invitePolicy, currentWorkspace] = await Promise.all([
    getWorkspaceFeatureFlags(workspaceId),
    requireWorkspaceMembership({ actor, workspaceId }),
    getMemberInvitePolicy(workspaceId).catch(() => null),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  if (isDemo) notFound();
  const meetingRecorderConfig = featureFlags.MEETING_RECORDERS
    ? await getMeetingRecorderConfig(actor, workspaceId).catch(() => null)
    : null;
  const meetingRecorderEnabled = Boolean(
    featureFlags.MEETING_RECORDERS && meetingRecorderConfig?.featureEnabled && meetingRecorderConfig.config.enabled,
  );

  const returnTo = sanitizeWorkspaceReturnTo(workspaceId, search.returnTo);
  const contextCircleId = circleIdFromReturnTo(returnTo, workspaceId);
  const returnUrl = new URL(returnTo, "https://app.local");
  const contextAccountId = crmAccountIdFromPath(returnUrl.pathname, workspaceId);
  const contextDealStage = creatableDealStageFromSearch(search);
  const allowedActions = getWorkspaceAddActions({
    workspaceId,
    pathname: returnUrl.pathname,
    searchParams: returnUrl.search,
    featureFlags,
    role: membership?.role ?? null,
    invitePolicy,
    meetingRecorderEnabled,
    isDemo,
  });
  if (!allowedActions.some((action) => action.kind === kind)) notFound();

  const needsProposals = kind === "action" || kind === "tension";
  const needsMembers = kind === "action"
    || kind === "tension"
    || kind === "goal"
    || kind === "allocation"
    || kind === "role_assignment"
    || kind === "deal"
    || kind === "crm_activity"
    || kind === "communication_suggestion";
  const needsCircles = kind === "goal" || kind === "circle" || kind === "role" || kind === "tool_link";
  const needsRoles = kind === "role_assignment";
  const needsGoals = kind === "goal";
  const needsContacts = kind === "deal" || kind === "crm_activity" || kind === "communication_suggestion";
  const needsAccounts = (kind === "crm_activity" || kind === "communication_suggestion") && !contextAccountId;
  const needsDeals = kind === "crm_activity" || kind === "communication_suggestion";
  const needsCycles = kind === "allocation";
  const needsApprovedProspects = kind === "prospect_instance";

  const [
    proposalsResult,
    members,
    circles,
    goals,
    contactsResult,
    accountsResult,
    dealsResult,
    cyclesResult,
    approvedQualificationsResult,
    roles,
  ] = await Promise.all([
    needsProposals ? listProposals(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsMembers ? listHumanMembers(workspaceId) : Promise.resolve([]),
    needsCircles ? listCircles(workspaceId) : Promise.resolve([]),
    needsGoals ? listGoals(actor, { workspaceId }) : Promise.resolve([]),
    needsContacts ? listContacts(actor, workspaceId, { take: 100, accountId: contextAccountId ?? undefined }) : Promise.resolve({ items: [] }),
    needsAccounts ? listCrmAccounts(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsDeals ? listDeals(actor, workspaceId, { take: 100, accountId: contextAccountId ?? undefined }) : Promise.resolve({ items: [] }),
    needsCycles ? listCycles(workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsApprovedProspects ? listQualifications(actor, workspaceId, { status: "APPROVED" }) : Promise.resolve({ items: [] }),
    needsRoles ? listRoles(workspaceId) : Promise.resolve([]),
  ]);

  const proposals = proposalsResult.items;
  const activeProposals = proposals.filter((proposal) => proposal.status === "DRAFT" || proposal.status === "OPEN");
  const contacts = contactsResult.items;
  const accounts = accountsResult.items;
  const deals = dealsResult.items;
  const cycles = cyclesResult.items;
  const allocatableCycles = cycles.filter((cycle) => cycle.status === "OPEN_ALLOCATIONS");
  const approvedQualifications = approvedQualificationsResult.items;
  const roleAssignmentRoles = contextCircleId
    ? roles.filter((role) => role.circle?.id === contextCircleId)
    : roles;
  const currentUserId = actor.kind === "user" ? actor.user.id : "";
  const title = kind === "meeting_manual_recording"
    ? "Record meeting now"
    : kind === "meeting_audio_upload"
      ? "Upload meeting audio"
    : kind === "upload_file"
      ? "Upload files from this device"
    : `Add ${WORKSPACE_ADD_ACTION_DEFINITIONS[kind].label}`;
  const uploadDefaultSource = workspaceSubpath(returnUrl.pathname, workspaceId)?.startsWith("/settings")
    ? "settings-upload"
    : "brain-upload";
  const actionMembers = members.map((member) => ({
    id: member.id,
    label: member.user.displayName ?? member.user.email,
  }));
  const actionEditorLabels = {
    title: "Title",
    notes: "Notes",
    assignee: "Assignee",
    assigneeNone: "No assignee",
    submit: "Create action",
    cancel: "Cancel",
    priority: {
      label: "Priority",
      help: "Use Normal for ordinary follow-up, High or Urgent when it should rise above other work.",
      none: "None",
      low: "Low",
      normal: "Normal",
      high: "High",
      urgent: "Urgent",
      legacy: "Current custom priority P{priority}",
    },
  };

  async function createActionAndReturn(formData: FormData) {
    "use server";
    await createActionAction(formData);
    redirect(returnTo);
  }

  async function createTensionAndReturn(formData: FormData) {
    "use server";
    await createTensionAction(formData);
    redirect(returnTo);
  }

  async function createProposalAndReturn(formData: FormData) {
    "use server";
    await createProposalAction(formData);
    redirect(returnTo);
  }

  async function createGoalAndReturn(formData: FormData) {
    "use server";
    await createGoalFormAction(formData);
    redirect(returnTo);
  }

  async function generateGoalsFromBrainAndReturn(formData: FormData) {
    "use server";
    await refreshCompanyDirectionFromBrainFormAction(formData);
    redirect(returnTo);
  }

  async function createCircleAndReturn(formData: FormData) {
    "use server";
    await createCircleAction(formData);
    redirect(returnTo);
  }

  async function createRoleAndReturn(formData: FormData) {
    "use server";
    await createRoleAction(formData);
    redirect(returnTo);
  }

  async function assignRoleAndReturn(formData: FormData) {
    "use server";
    await assignRoleAction(formData);
    redirect(returnTo);
  }

  async function createCycleAndReturn(formData: FormData) {
    "use server";
    await createCycleAction(formData);
    redirect(returnTo);
  }

  async function createAllocationAndReturn(formData: FormData) {
    "use server";
    await createAllocationAction(formData);
    redirect(returnTo);
  }

  async function createArticleAndReturn(formData: FormData) {
    "use server";
    await createArticleAction(formData);
    redirect(returnTo);
  }

  async function scheduleMeetingAndReturn(formData: FormData) {
    "use server";
    await createMeetingSeriesAction(formData);
    redirect(returnTo);
  }

  async function importMeetingInviteAndReturn(formData: FormData) {
    "use server";
    await importMeetingInviteAction(formData);
    redirect(returnTo);
  }

  async function uploadMeetingTranscriptAndReturn(formData: FormData) {
    "use server";
    await uploadMeetingTranscriptAction(formData);
    redirect(returnTo);
  }

  async function createContactAndReturn(formData: FormData) {
    "use server";
    await createContactAction(formData);
    redirect(returnTo);
  }

  async function createCrmAccountAndReturn(formData: FormData) {
    "use server";
    await createCrmAccountAction(formData);
    redirect(returnTo);
  }

  async function createDealAndReturn(formData: FormData) {
    "use server";
    await createDealAction(formData);
    redirect(returnTo);
  }

  async function createCrmActivityAndReturn(formData: FormData) {
    "use server";
    await createActivityAction(formData);
    redirect(returnTo);
  }

  async function createCommunicationSuggestionAndReturn(formData: FormData) {
    "use server";
    await createCommunicationSuggestionAction(formData);
    redirect(returnTo);
  }

  async function provisionProspectAndReturn(formData: FormData) {
    "use server";
    await provisionProspectWorkspaceAction(formData);
    redirect(returnTo);
  }

  async function inviteMemberAndReturn(formData: FormData) {
    "use server";
    const actor = await requirePageActor();
    const workspaceId = asString(formData, "workspaceId");
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    const invitePolicy = await getMemberInvitePolicy(workspaceId).catch(() => "ADMINS_ONLY");
    const result = membership?.role === "ADMIN"
      ? await createMemberAction(formData)
      : invitePolicy === "MEMBERS_CAN_REQUEST"
        ? await requestMemberInviteAction(formData)
        : await inviteMemberAction(formData);
    throwIfFailed(result);
    redirect(returnTo);
  }

  async function bulkInviteAndReturn(formData: FormData) {
    "use server";
    const result = await bulkInviteAction(formData);
    throwIfFailed(result);
    redirect(returnTo);
  }

  async function createWebhookAndReturn(formData: FormData) {
    "use server";
    await createWebhookEndpointAction(formData);
    redirect(returnTo);
  }

  async function publishToolLinkAndReturn(formData: FormData) {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    await createWorkspaceToolLink(actor, {
      workspaceId,
      title: asString(formData, "title"),
      url: asString(formData, "url"),
      category: asOptional(formData, "category"),
      descriptionMd: asOptional(formData, "descriptionMd"),
      accessNotesMd: asOptional(formData, "accessNotesMd"),
      previewTitle: asOptional(formData, "previewTitle"),
      previewDescription: asOptional(formData, "previewDescription"),
      previewImageUrl: asOptional(formData, "previewImageUrl"),
      credentialLabel: asOptional(formData, "credentialLabel"),
      credentialSecret: asOptional(formData, "credentialSecret"),
      circleIds: formData.getAll("circleIds").map((value) => String(value)),
    });
    refresh(workspaceId);
    redirect(returnTo);
  }

  async function submitToolAppAndReturn(formData: FormData) {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    const title = asString(formData, "title");
    const outcome = asString(formData, "outcome");
    const descriptionMd = asString(formData, "descriptionMd");
    await createCatalogRequest(actor, {
      workspaceId,
      type: "PUBLISH",
      title,
      reasonMd: outcome || descriptionMd,
      requestedScopes: splitList(asOptional(formData, "requestedScopes")),
      requestedBudgetCents: parseOptionalNumber(asOptional(formData, "requestedBudgetCents")),
      requestedDailyCallLimit: parseOptionalNumber(asOptional(formData, "requestedDailyCallLimit")),
      payloadJson: {
        type: "APP",
        title,
        url: asString(formData, "url"),
        proofUrl: asOptional(formData, "proofUrl"),
        outcome,
        descriptionMd,
        category: "VIBE_CODED",
      },
    });
    refresh(workspaceId);
    redirect(returnTo);
  }

  async function pasteTextAndReturn(formData: FormData) {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    const sourceType = asString(formData, "sourceType") as BrainSourceType;
    const content = asString(formData, "content");
    if (sourceType === "MEETING") {
      const result = await intakeMeetingTranscript(actor, {
        workspaceId,
        transcript: content,
        title: asOptional(formData, "title"),
        source: asOptional(formData, "channel") ?? "text-paste",
        recordedAt: parseOptionalMeetingDateTimeInput(
          asOptional(formData, "recordedAt"),
          asOptional(formData, "timeZone"),
          "Meeting recorded at",
        ),
        ingestionGuidanceMd: asOptional(formData, "ingestionGuidanceMd"),
      });
      if (result.status === "needs_clarification") {
        throw new Error(result.message);
      }
    } else {
      await ingestSource(actor, {
        workspaceId,
        sourceType,
        tier: 1,
        content,
        title: asOptional(formData, "title") ?? undefined,
        channel: asOptional(formData, "channel") ?? undefined,
        authorMemberId: membership?.id === "global-operator" ? null : membership?.id ?? null,
        ingestionGuidanceMd: asOptional(formData, "ingestionGuidanceMd"),
      });
    }
    refresh(workspaceId);
    redirect(returnTo);
  }

  async function addDatabaseAndReturn(formData: FormData) {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
    await createExternalDataSource(actor, {
      workspaceId,
      label: asString(formData, "label"),
      driverType: "postgres",
      connectionStringEnc: encrypt(asString(formData, "connectionString")),
      selectedTables: splitList(asString(formData, "selectedTables")),
      pullCadenceMinutes: asOptionalInt(formData, "pullCadenceMinutes") ?? 60,
      cursorColumn: asOptional(formData, "cursorColumn") ?? "updated_at",
    });
    refresh(workspaceId);
    redirect(returnTo);
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{title}</h1>
            <div className="nr-masthead-meta">
              <span>{WORKSPACE_ADD_ACTION_DEFINITIONS[kind].description}</span>
            </div>
          </div>
          {cancelLink(returnTo)}
        </div>
      </header>

      <section className="ws-section">
        {kind === "meeting_schedule" && (
          <form action={scheduleMeetingAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Description<textarea name="description" /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Starts at<input name="startsAt" type="datetime-local" required /></label>
              <label style={{ flex: 1 }}>Duration (minutes)<input name="durationMinutes" type="number" min={MIN_MEETING_DURATION_MINUTES} max={MAX_MEETING_DURATION_MINUTES} step={1} defaultValue={DEFAULT_MEETING_DURATION_MINUTES} /></label>
            </div>
            <TimeZoneSelect />
            <label>
              Recurrence
              <select name="recurrenceRule" defaultValue="">
                <option value="">None</option>
                <option value="FREQ=DAILY">Daily</option>
                <option value="FREQ=WEEKLY">Weekly</option>
                <option value="FREQ=MONTHLY">Monthly</option>
              </select>
            </label>
            <label>Participant emails<input name="participantEmails" placeholder="one@example.com, two@example.com" /></label>
            <label>Participant IDs<input name="participantIds" placeholder="member ids, comma-separated" /></label>
            <div className="actions-inline"><button type="submit">Schedule meeting</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "meeting_invite" && (
          <form action={importMeetingInviteAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Calendar invite<input name="invite" type="file" accept=".ics,text/calendar" required /></label>
            <div className="actions-inline"><button type="submit">Import invite</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "meeting_transcript" && (
          <form action={uploadMeetingTranscriptAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Source<input name="source" defaultValue="transcript-upload" required /></label>
              <label style={{ flex: 1 }}>Recorded at<input name="recordedAt" type="datetime-local" required /></label>
            </div>
            <TimeZoneSelect />
            <label>Participant emails<input name="participantEmails" placeholder="one@example.com, two@example.com" /></label>
            <label>Ingestion guidance<MarkdownEditor name="ingestionGuidanceMd" rows={3} /></label>
            <label>Transcript file<input name="file" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" /></label>
            <label>Transcript<textarea name="transcript" rows={8} /></label>
            <div className="actions-inline"><button type="submit">Upload transcript</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "meeting_manual_recording" && (
          <ManualMeetingRecordingForm workspaceId={workspaceId} cancelHref={returnTo} />
        )}

        {kind === "meeting_audio_upload" && (
          <MeetingAudioUploadForm workspaceId={workspaceId} cancelHref={returnTo} />
        )}

        {kind === "action" && (
          <ActionEditorForm
            action={createActionAndReturn}
            workspaceId={workspaceId}
            members={actionMembers}
            labels={actionEditorLabels}
            priority={2}
            cancelHref={returnTo}
          >
            <label>
              Link to proposal
              <select name="proposalId" defaultValue="">
                <option value="">None</option>
                {activeProposals.map((proposal) => <option value={proposal.id} key={proposal.id}>{proposal.title}</option>)}
              </select>
            </label>
          </ActionEditorForm>
        )}

        {kind === "tension" && (
          <form action={createTensionAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Description<MarkdownEditor name="bodyMd" rows={5} /></label>
            <label>Priority<input name="priority" type="number" min={0} defaultValue={0} /></label>
            <label>
              Raised by
              <select name="raisedByMemberId" defaultValue="">
                <option value="">None</option>
                {members.map((member) => <option value={member.id} key={member.id}>{member.user.displayName ?? member.user.email}</option>)}
              </select>
            </label>
            <label>
              Link to proposal
              <select name="proposalId" defaultValue="">
                <option value="">None</option>
                {activeProposals.map((proposal) => <option value={proposal.id} key={proposal.id}>{proposal.title}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}>
              <input type="checkbox" name="isPrivate" defaultChecked style={{ width: "auto" }} />
              Private inbox item
            </label>
            <div className="actions-inline"><button type="submit">Create tension</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "proposal" && (
          <form action={createProposalAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Summary<input name="summary" /></label>
            <label>Body<MarkdownEditor name="bodyMd" required rows={8} /></label>
            <label>Priority<input name="priority" type="number" min={0} defaultValue={0} /></label>
            <label style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}>
              <input type="checkbox" name="isPrivate" defaultChecked style={{ width: "auto" }} />
              Private draft
            </label>
            <div className="actions-inline"><button type="submit">Create proposal</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "goal" && (
          <form action={createGoalAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Description<MarkdownEditor name="descriptionMd" rows={4} /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Cadence<select name="cadence" defaultValue="QUARTERLY">{CADENCES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label style={{ flex: 1 }}>Level<select name="level" defaultValue="COMPANY">{GOAL_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
              <label style={{ flex: 1 }}>Status<select name="status" defaultValue="DRAFT">{GOAL_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            </div>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Start date<input name="startDate" type="date" /></label>
              <label style={{ flex: 1 }}>Target date<input name="targetDate" type="date" /></label>
            </div>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Parent goal<select name="parentGoalId" defaultValue=""><option value="">None</option>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
              <label style={{ flex: 1 }}>Circle<select name="circleId" defaultValue=""><option value="">None</option>{circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}</select></label>
              <label style={{ flex: 1 }}>Owner<select name="ownerMemberId" defaultValue=""><option value="">None</option>{members.map((member) => <option key={member.id} value={member.id}>{member.user.displayName ?? member.user.email}</option>)}</select></label>
            </div>
            <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
              <legend className="nr-meta" style={{ padding: "0 6px" }}>Key results</legend>
              {[0, 1, 2].map((index) => (
                <div key={index} className="actions-inline">
                  <input name="keyResultTitle" placeholder="Key result" />
                  <input name="keyResultCurrent" type="number" step="any" placeholder="Current" style={{ width: 130 }} />
                  <input name="keyResultTarget" type="number" step="any" placeholder="Target" style={{ width: 130 }} />
                  <input name="keyResultUnit" placeholder="Unit" style={{ width: 120 }} />
                </div>
              ))}
            </fieldset>
            <div className="actions-inline"><button type="submit">Create goal</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "generate_goals_from_brain" && (
          <form action={generateGoalsFromBrainAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <p className="nr-muted" style={{ margin: 0 }}>
              Run the company-understanding agent over absorbed Brain evidence and apply generated goals to the normal ladder.
            </p>
            <div className="actions-inline"><button type="submit">Generate goals</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "circle" && (
          <form action={createCircleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Name<input name="name" required /></label>
            <label>Parent circle<select name="parentCircleId" defaultValue={contextCircleId ?? ""}><option value="">None</option>{circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}</select></label>
            <label>Purpose<textarea name="purposeMd" /></label>
            <label>Domain<textarea name="domainMd" /></label>
            <div className="actions-inline"><button type="submit">Create circle</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "role" && (
          <form action={createRoleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Circle<select name="circleId" required defaultValue={contextCircleId ?? circles[0]?.id ?? ""}>{circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}</select></label>
            <label>Name<input name="name" required /></label>
            <label>Purpose<textarea name="purposeMd" /></label>
            <label>Accountabilities<textarea name="accountabilities" placeholder="One accountability per line" /></label>
            <div className="actions-inline"><button type="submit" disabled={circles.length === 0}>Create role</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "role_assignment" && (
          <form action={assignRoleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>
              Role
              <select name="roleId" required defaultValue={roleAssignmentRoles[0]?.id ?? ""}>
                {roleAssignmentRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}{role.circle?.name ? ` (${role.circle.name})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Member
              <select name="memberId" required defaultValue={members[0]?.id ?? ""}>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{member.user.displayName ?? member.user.email}</option>
                ))}
              </select>
            </label>
            {roleAssignmentRoles.length === 0 && <p className="form-message form-message-error">Create a role in this circle before adding members.</p>}
            {members.length === 0 && <p className="form-message form-message-error">Invite a member before assigning roles.</p>}
            <div className="actions-inline">
              <button type="submit" disabled={roleAssignmentRoles.length === 0 || members.length === 0}>Add member</button>
              {cancelLink(returnTo)}
            </div>
          </form>
        )}

        {kind === "cycle" && (
          <form action={createCycleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Name<input name="name" required /></label>
            <label>Cadence<input name="cadence" defaultValue="monthly" required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Start date<input name="startDate" type="date" required /></label>
              <label style={{ flex: 1 }}>End date<input name="endDate" type="date" required /></label>
            </div>
            <label>Points per member<input name="pointsPerUser" type="number" min={1} defaultValue={100} required /></label>
            <div className="actions-inline"><button type="submit">Create cycle</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "allocation" && (
          <form action={createAllocationAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Cycle<select name="cycleId" required defaultValue={allocatableCycles[0]?.id ?? ""}>{allocatableCycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}</select></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>From<select name="fromUserId" defaultValue={currentUserId}>{members.map((member) => <option key={member.id} value={member.userId}>{member.user.displayName ?? member.user.email}</option>)}</select></label>
              <label style={{ flex: 1 }}>To<select name="toUserId" required defaultValue={members[0]?.userId ?? ""}>{members.map((member) => <option key={member.id} value={member.userId}>{member.user.displayName ?? member.user.email}</option>)}</select></label>
            </div>
            <div className="actions-inline">
              <input name="points" type="number" min={1} placeholder="Points" required />
              <input name="note" placeholder="Note" />
            </div>
            {allocatableCycles.length === 0 && <p className="form-message form-message-error">No cycles are currently open for allocations.</p>}
            <div className="actions-inline"><button type="submit" disabled={allocatableCycles.length === 0}>Create allocation</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "article" && (
          <form action={createArticleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Type<select name="type">{ARTICLE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label style={{ flex: 1 }}>Authority<select name="authority" defaultValue="DRAFT"><option value="DRAFT">Draft</option><option value="REFERENCE">Reference</option><option value="AUTHORITATIVE">Authoritative</option></select></label>
            </div>
            <label>Body<MarkdownEditor name="bodyMd" required rows={8} /></label>
            <label style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}>
              <input type="checkbox" name="isPrivate" defaultChecked style={{ width: "auto" }} />
              Private draft
            </label>
            <div className="actions-inline"><button type="submit">Create article</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "tool_app" && (
          <form action={submitToolAppAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <div className="actions-inline">
              <label style={{ flex: 1 }}>App name<input name="title" required /></label>
              <label style={{ flex: 1 }}>App URL<input name="url" type="url" required placeholder="https://example.com/app" /></label>
            </div>
            <label>Proof link<input name="proofUrl" placeholder="Build, demo, or artifact link" /></label>
            <label>Outcome<input name="outcome" required placeholder="What business outcome does this app produce?" /></label>
            <label>Description<MarkdownEditor name="descriptionMd" rows={4} required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Requested scopes<input name="requestedScopes" placeholder="workspace:read brain:read" /></label>
              <label style={{ flex: 1 }}>Monthly budget cents<input name="requestedBudgetCents" type="number" min="0" /></label>
              <label style={{ flex: 1 }}>Daily call limit<input name="requestedDailyCallLimit" type="number" min="0" /></label>
            </div>
            <div className="actions-inline"><button type="submit">Submit to admins</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "tool_link" && (
          <form action={publishToolLinkAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Title<input name="title" required /></label>
              <label style={{ flex: 1 }}>URL<input name="url" required placeholder="https://example.com" /></label>
              <label style={{ flex: 1 }}>Category<input name="category" defaultValue="OTHER" /></label>
            </div>
            <label>Description<MarkdownEditor name="descriptionMd" rows={4} /></label>
            <label>Access notes<MarkdownEditor name="accessNotesMd" rows={4} /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Preview title<input name="previewTitle" /></label>
              <label style={{ flex: 1 }}>Preview image URL<input name="previewImageUrl" /></label>
            </div>
            <label>Preview description<input name="previewDescription" /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Credential label<input name="credentialLabel" /></label>
              <label style={{ flex: 1 }}>Credential secret<input name="credentialSecret" type="password" /></label>
            </div>
            {circles.length > 0 && (
              <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
                <legend style={{ padding: "0 6px", fontWeight: 600 }}>Circles</legend>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                  {circles.map((circle) => (
                    <label key={circle.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" name="circleIds" value={circle.id} style={{ width: "auto" }} />
                      {circle.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="actions-inline"><button type="submit">Publish link</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "crm_account" && (
          <form action={createCrmAccountAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>Account name<input type="text" name="name" required /></label>
              <label>Domain<input type="text" name="domain" placeholder="example.com" /></label>
              <label>
                Relationship type
                <select name="relationshipType" defaultValue="PROSPECT">
                  {CRM_RELATIONSHIP_OPTIONS.map((option) => (
                    <option key={option} value={option}>{labelFromCrmCode(option)}</option>
                  ))}
                </select>
              </label>
              <label>
                Lifecycle stage
                <select name="lifecycleStage" defaultValue="DISCOVERY">
                  {CRM_LIFECYCLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{labelFromCrmCode(option)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>Description<MarkdownEditor name="descriptionMd" rows={3} /></label>
            <div className="actions-inline"><button type="submit">Create account</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "contact" && (
          <form action={createContactAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            {contextAccountId && <input type="hidden" name="accountId" value={contextAccountId} />}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>Email<input type="email" name="email" required /></label>
              <label>Name<input type="text" name="name" /></label>
              <label>Company<input type="text" name="company" /></label>
              <label>Title<input type="text" name="title" /></label>
              <label>Phone<input type="text" name="phone" /></label>
            </div>
            <div className="actions-inline"><button type="submit">Create contact</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "deal" && (
          <form action={createDealAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            {contextAccountId && <input type="hidden" name="accountId" value={contextAccountId} />}
            {contextDealStage && <input type="hidden" name="stage" value={contextDealStage} />}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>
                Contact
                <select name="contactId" required>
                  <option value="">Choose contact</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}
                </select>
              </label>
              <label>Deal title<input type="text" name="title" required /></label>
              <label>Value<input type="number" name="value" step="0.01" min="0" /></label>
              <label>
                Owner
                <select name="ownerUserId" defaultValue="">
                  <option value="">No owner</option>
                  {members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="actions-inline"><button type="submit" disabled={contacts.length === 0}>Create deal</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "crm_activity" && (
          <form action={createCrmActivityAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <input type="hidden" name="source" value="manual" />
            {contextAccountId ? (
              <input type="hidden" name="accountId" value={contextAccountId} />
            ) : (
              <label>
                Account
                <select name="accountId" required>
                  <option value="">Choose account</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>
                Contact
                <select name="contactId" defaultValue="">
                  <option value="">No contact</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}
                </select>
              </label>
              <label>
                Deal
                <select name="dealId" defaultValue="">
                  <option value="">No deal</option>
                  {deals.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}
                </select>
              </label>
              <label>
                Type
                <select name="type" defaultValue="TASK">
                  {CRM_ACTIVITY_TYPES.map((option) => <option key={option} value={option}>{labelFromCrmCode(option)}</option>)}
                </select>
              </label>
              <label>Title<input name="title" required /></label>
              <label>Due date<input type="date" name="dueAt" /></label>
              <label>
                Owner
                <select name="ownerUserId" defaultValue="">
                  <option value="">No owner</option>
                  {members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>
                  ))}
                </select>
              </label>
            </div>
            <MarkdownEditor name="bodyMd" rows={3} />
            <div className="actions-inline"><button type="submit" disabled={!contextAccountId && accounts.length === 0}>Create activity</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "communication_suggestion" && (
          <form action={createCommunicationSuggestionAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <input type="hidden" name="channel" value="EMAIL" />
            <input type="hidden" name="source" value="manual" />
            {contextAccountId ? (
              <input type="hidden" name="accountId" value={contextAccountId} />
            ) : (
              <label>
                Account
                <select name="accountId" required>
                  <option value="">Choose account</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>
                Contact
                <select name="contactId" defaultValue="">
                  <option value="">No contact</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}
                </select>
              </label>
              <label>
                Deal
                <select name="dealId" defaultValue="">
                  <option value="">No deal</option>
                  {deals.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}
                </select>
              </label>
              <label>
                Owner
                <select name="ownerUserId" defaultValue="">
                  <option value="">No owner</option>
                  {members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>
                  ))}
                </select>
              </label>
              <label>Title<input name="title" required /></label>
              <label>Recipient email<input type="email" name="recipientEmail" /></label>
              <label>Subject<input name="subject" /></label>
            </div>
            <label>Body<MarkdownEditor name="bodyMd" rows={5} required /></label>
            <div className="actions-inline"><button type="submit" disabled={!contextAccountId && accounts.length === 0}>Create suggestion</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "prospect_instance" && (
          <form action={provisionProspectAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>
              Prospect
              <select name="demoLeadId" required defaultValue="">
                <option value="">Choose lead</option>
                {approvedQualifications.map((qualification: any) => (
                  <option key={qualification.demoLeadId} value={qualification.demoLeadId}>
                    {qualification.companyName || qualification.demoLead?.email || "Unknown lead"}
                  </option>
                ))}
              </select>
            </label>
            <label>Admin email<input type="email" name="adminEmail" required /></label>
            <div className="actions-inline"><button type="submit" disabled={approvedQualifications.length === 0}>Provision instance</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "member_invite" && (
          <form action={inviteMemberAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>Name<input name="displayName" /></label>
              <label>Email<input name="email" type="email" required /></label>
            </div>
            {membership?.role === "ADMIN" && (
              <label>
                System role
                <select name="role" defaultValue="CONTRIBUTOR">
                  <option value="CONTRIBUTOR">Contributor</option>
                  <option value="FACILITATOR">Facilitator</option>
                  <option value="FINANCE_STEWARD">Finance steward</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </label>
            )}
            <div className="actions-inline"><button type="submit">{invitePolicy === "MEMBERS_CAN_REQUEST" && membership?.role !== "ADMIN" ? "Request invite" : "Send invite"}</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "member_bulk_invite" && (
          <form action={bulkInviteAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>CSV rows<textarea name="csvData" rows={8} placeholder="Name, email@example.com, CONTRIBUTOR" required /></label>
            <div className="actions-inline"><button type="submit">Send bulk invites</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "webhook" && (
          <form action={createWebhookAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label>Webhook URL<input name="url" type="url" required placeholder="https://example.com/webhook" /></label>
              <label>Label<input name="label" placeholder="Ops webhook" /></label>
            </div>
            <label>Event types<input name="eventTypes" placeholder="meeting.created, action.created" /></label>
            <div className="actions-inline"><button type="submit">Create webhook</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "upload_file" && (
          <KnowledgeFileUploader
            workspaceId={workspaceId}
            defaultSource={uploadDefaultSource}
            initiallyOpen
            showTrigger={false}
            heading="Upload files from this device"
            description="Choose PDFs, docs, spreadsheets, notes, images, or folders from this phone or computer."
            cancelHref={returnTo}
          />
        )}

        {kind === "paste_text" && (
          <form action={pasteTextAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Source type<select name="sourceType" defaultValue="ARTICLE">{SOURCE_TYPES.map((sourceType) => <option key={sourceType} value={sourceType}>{sourceType}</option>)}</select></label>
              <label style={{ flex: 1 }}>Channel or source<input name="channel" placeholder="text-paste" /></label>
            </div>
            <label>Meeting recorded at<input name="recordedAt" type="datetime-local" /></label>
            <TimeZoneSelect />
            <label>Content<textarea name="content" rows={10} required /></label>
            <label>Ingestion guidance<MarkdownEditor name="ingestionGuidanceMd" rows={3} /></label>
            <div className="actions-inline"><button type="submit">Ingest text</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "database_source" && (
          <form action={addDatabaseAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Label<input name="label" required placeholder="Analytics replica" /></label>
            <label>Connection string<input name="connectionString" type="password" required placeholder="postgres://..." /></label>
            <label>Selected tables<input name="selectedTables" required placeholder="public.accounts, public.events" /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Pull cadence minutes<input name="pullCadenceMinutes" type="number" min="5" defaultValue={60} required /></label>
              <label style={{ flex: 1 }}>Cursor column<input name="cursorColumn" defaultValue="updated_at" required /></label>
            </div>
            <div className="actions-inline"><button type="submit">Save database</button>{cancelLink(returnTo)}</div>
          </form>
        )}
      </section>
    </>
  );
}
