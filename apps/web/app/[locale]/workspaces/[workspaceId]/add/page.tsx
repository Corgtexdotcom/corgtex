import type {
  AdviceRequestAudienceType,
  AdviceRequestPreferredChannel,
  BrainArticleAuthority,
  BrainArticleType,
  BrainSourceType,
  GoalCadence,
  GoalLevel,
  GoalStatus,
} from "@prisma/client";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import {
  AppError,
  AGREEMENT_BRAIN_ARTICLE_TYPES,
  createCatalogRequest,
  createAction,
  createActionChecklistItem,
  createAdviceRequest,
  createExternalDataSource,
  createProposal,
  createTension,
  createWorkspaceToolLink,
  canManagePracticeFinanceProjects,
  duplicateGuardErrorPayload,
  getMeetingRecorderConfig,
  getMemberInvitePolicy,
  isDuplicateGuardMatchError,
  listActions,
  listCrmAccounts,
  listDeals,
  ingestSource,
  listCircles,
  listContacts,
  listGoals,
  listHumanMembers,
  listProposals,
  listQualifications,
  listRoles,
  listTensions,
  requireWorkspaceMembership,
  upsertWorkspaceExternalResourceFromUrl,
} from "@corgtex/domain";
import { encrypt } from "@corgtex/connectors-sql";
import { prisma, type AppActor } from "@corgtex/shared";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MultiSelectFilter, type MultiSelectFilterOption } from "@/lib/components/MultiSelectFilter";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import { DEFAULT_WORK_ITEM_PRIORITY_LABELS } from "@/lib/work-item-priority";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import {
  DEFAULT_MEETING_DURATION_MINUTES,
  MAX_MEETING_DURATION_MINUTES,
  MIN_MEETING_DURATION_MINUTES,
} from "@/lib/meeting-timezone";
import { KnowledgeFileUploader } from "../KnowledgeFileUploader";
import { ManualMeetingRecordingForm } from "./ManualMeetingRecordingForm";
import { MeetingAudioUploadForm } from "./MeetingAudioUploadForm";
import {
  crmAccountIdFromPath,
  getWorkspaceAddActions,
  isWorkspaceAddActionKind,
  roleIdFromPath,
  sanitizeWorkspaceReturnTo,
  WORKSPACE_ADD_ACTION_DEFINITIONS,
  workspaceSubpath,
  type WorkspaceAddActionKind,
} from "@/lib/workspace-add-actions";
import {
  assignRoleAction,
  bulkInviteAction,
  createActivityAction,
  createCircleAction,
  createCommunicationSuggestionAction,
  createContactAction,
  createCrmAccountAction,
  createDealAction,
  createMeetingSeriesAction,
  createMemberAction,
  createRoleAction,
  createWebhookEndpointAction,
  importMeetingInviteAction,
  inviteMemberAction,
  provisionProspectWorkspaceAction,
  requestMemberInviteAction,
} from "../actions";
import { createArticleAction } from "../brain/actions";
import { createGoalFormAction, refreshCompanyDirectionFromBrainFormAction } from "../goals/actions";
import { asOptional, asOptionalInt, asString, duplicateGuardFromFormData, refresh } from "../action-utils";
import {
  CRM_ACTIVITY_TYPES,
  CRM_CREATABLE_DEAL_STAGES,
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  labelFromCrmCode,
} from "../leads/view-model";
import { createPracticeProjectAction } from "../finance/actions";
import { MeetingTranscriptUploadForm } from "../meetings/MeetingTranscriptUploadForm";
import { DuplicateGuardActionEditorForm } from "./DuplicateGuardActionEditorForm";
import { DuplicateGuardForm, DuplicateGuardSubmitButton, type DuplicateGuardFormState } from "./DuplicateGuardForm";
import { PasteTextForm } from "./PasteTextForm";
import { PracticeProjectAddPanel } from "./PracticeProjectAddPanel";

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
const AGREEMENT_ARTICLE_TYPES: BrainArticleType[] = [...AGREEMENT_BRAIN_ARTICLE_TYPES];
const ARTICLE_AUTHORITIES: BrainArticleAuthority[] = ["DRAFT", "REFERENCE", "AUTHORITATIVE"];
const AGREEMENT_ARTICLE_AUTHORITIES: BrainArticleAuthority[] = ["REFERENCE", "AUTHORITATIVE"];
const ARTICLE_AUTHORITY_LABELS: Record<BrainArticleAuthority, string> = {
  DRAFT: "Draft",
  REFERENCE: "Reference",
  AUTHORITATIVE: "Authoritative",
  HISTORICAL: "Historical",
};
const SOURCE_TYPES: BrainSourceType[] = ["MEETING", "TICKET", "PR", "RFC", "INCIDENT", "SLACK", "CUSTOMER_FEEDBACK", "COMPETITOR", "RESEARCH", "ARTICLE", "DOC", "RUNBOOK", "EMAIL", "FILE_UPLOAD", "EXTERNAL_CONTENT"];
const REQUEST_AUDIENCE_TYPES: AdviceRequestAudienceType[] = ["WORKSPACE", "MEMBERS", "CIRCLE"];
const REQUEST_CHANNELS: AdviceRequestPreferredChannel[] = ["IN_APP", "SLACK", "EMAIL", "COPY"];
const CREATE_ADD_ON_STYLE = { border: "1px solid var(--line)", borderRadius: 8, padding: 12 } as const;

type WorkItemCreateIntent = "draft" | "open";

type CreateRequestAddOn = {
  audienceType: AdviceRequestAudienceType;
  memberIds: string[];
  targetCircleId: string | null;
  messageMd: string;
  deadlineAt: Date | null;
  reminderAt: Date | null;
  preferredChannel: AdviceRequestPreferredChannel | null;
};

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

function asStringArray(formData: FormData, key: string) {
  return Array.from(new Set(formData.getAll(key).map((value) => String(value).trim()).filter(Boolean)));
}

function asOptionalDate(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value ? new Date(value) : null;
}

function createIntentFromForm(formData: FormData): WorkItemCreateIntent {
  return asString(formData, "submitIntent") === "open" ? "open" : "draft";
}

function requestAudienceFromForm(formData: FormData): AdviceRequestAudienceType {
  const audienceType = asString(formData, "requestAudienceType") as AdviceRequestAudienceType;
  return REQUEST_AUDIENCE_TYPES.includes(audienceType) ? audienceType : "WORKSPACE";
}

function requestChannelFromForm(formData: FormData) {
  const preferredChannel = asOptional(formData, "requestPreferredChannel") as AdviceRequestPreferredChannel | null;
  return preferredChannel && REQUEST_CHANNELS.includes(preferredChannel) ? preferredChannel : null;
}

function shouldApplyCreateAddOns(formData: FormData) {
  return asOptional(formData, "duplicateResolution") !== "use_existing";
}

function parseCreateRequestDate(formData: FormData, key: string, label: string) {
  const value = asOptional(formData, key);
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a valid date.`);
  }
  if (date.getTime() <= Date.now()) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be in the future.`);
  }
  return date;
}

function createRequestAddOnFromForm(formData: FormData): CreateRequestAddOn | null {
  const messageMd = asOptional(formData, "requestMessageMd");
  if (!messageMd) return null;

  const audienceType = requestAudienceFromForm(formData);
  const deadlineAt = parseCreateRequestDate(formData, "requestDeadlineAt", "Deadline");
  const reminderAt = parseCreateRequestDate(formData, "requestReminderAt", "Reminder");
  if (deadlineAt && reminderAt && reminderAt > deadlineAt) {
    throw new AppError(400, "INVALID_INPUT", "Reminder must be before or at the deadline.");
  }

  return {
    audienceType,
    memberIds: audienceType === "MEMBERS" ? asStringArray(formData, "requestMemberIds") : [],
    targetCircleId: audienceType === "CIRCLE" ? asOptional(formData, "requestTargetCircleId") : null,
    messageMd,
    deadlineAt,
    reminderAt,
    preferredChannel: requestChannelFromForm(formData),
  };
}

async function validateCreateRequestAddOn(actor: AppActor, params: {
  workspaceId: string;
  formData: FormData;
  intent: WorkItemCreateIntent;
  applyAddOns: boolean;
}) {
  if (params.intent !== "open" || !params.applyAddOns) return null;
  const request = createRequestAddOnFromForm(params.formData);
  if (!request) return null;
  if (actor.kind !== "user") {
    throw new AppError(400, "INVALID_ACTOR", "Only users can request input.");
  }

  if (request.audienceType === "MEMBERS") {
    if (request.memberIds.length === 0) {
      throw new AppError(400, "INVALID_INPUT", "Choose at least one person to request input from.");
    }
    const memberCount = await prisma.member.count({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        id: { in: request.memberIds },
      },
    });
    if (memberCount !== request.memberIds.length) {
      throw new AppError(400, "INVALID_INPUT", "Every selected recipient must be an active workspace member.");
    }
  }

  if (request.audienceType === "CIRCLE") {
    if (!request.targetCircleId) {
      throw new AppError(400, "INVALID_INPUT", "Choose a circle to request input from.");
    }
    const circle = await prisma.circle.findFirst({
      where: {
        id: request.targetCircleId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!circle) {
      throw new AppError(400, "INVALID_INPUT", "Target circle must belong to this workspace.");
    }
  }

  return request;
}

async function maybeAttachCreateReference(actor: AppActor, params: {
  workspaceId: string;
  entityType: "Action" | "Tension" | "Proposal";
  entityId: string;
  formData: FormData;
}) {
  const url = asOptional(params.formData, "referenceUrl");
  if (!url) return;

  await upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId: params.workspaceId,
    url,
    descriptionMd: asOptional(params.formData, "referenceDescriptionMd"),
    entityType: params.entityType,
    entityId: params.entityId,
    purpose: "reference",
  });
}

async function maybeCreateRequestFromForm(actor: AppActor, params: {
  workspaceId: string;
  subjectType: "ACTION" | "TENSION" | "PROPOSAL";
  subjectId: string;
  request: CreateRequestAddOn | null;
  canSendRequest: boolean;
}) {
  if (!params.request || !params.canSendRequest) return;
  await createAdviceRequest(actor, {
    workspaceId: params.workspaceId,
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    audienceType: params.request.audienceType,
    memberIds: params.request.memberIds,
    targetCircleId: params.request.targetCircleId,
    messageMd: params.request.messageMd,
    deadlineAt: params.request.deadlineAt,
    reminderAt: params.request.reminderAt,
    preferredChannel: params.request.preferredChannel,
  });
}

async function maybeCreateActionChecklist(actor: AppActor, params: {
  workspaceId: string;
  actionId: string;
  formData: FormData;
  canEditChecklist: boolean;
}) {
  if (!params.canEditChecklist) return;
  for (const title of splitList(asOptional(params.formData, "checklistItems"))) {
    await createActionChecklistItem(actor, {
      workspaceId: params.workspaceId,
      actionId: params.actionId,
      title,
    });
  }
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

function duplicateGuardState(error: unknown, formData?: FormData): DuplicateGuardFormState {
  if (isDuplicateGuardMatchError(error)) {
    const state = duplicateGuardErrorPayload(error);
    const submitIntent = formData ? asOptional(formData, "submitIntent") : null;
    return submitIntent ? { ...state, submitIntent } : state;
  }
  throw error;
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

function WorkItemAddOnSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="stack" style={CREATE_ADD_ON_STYLE}>
      <summary
        className="nr-hide-marker"
        style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 12, fontWeight: 650 }}
      >
        <span>{title}</span>
        <span aria-hidden="true">+</span>
      </summary>
      <div className="stack" style={{ marginTop: 12 }}>
        {children}
      </div>
    </details>
  );
}

function CreateReferenceFields() {
  return (
    <>
      <label>
        Reference link
        <input name="referenceUrl" type="url" placeholder="https://..." />
      </label>
      <label>
        Description
        <MarkdownEditor name="referenceDescriptionMd" rows={3} />
      </label>
    </>
  );
}

function CreateRequestFields({
  messageLabel,
  memberOptions,
  circles,
}: {
  messageLabel: string;
  memberOptions: WorkItemMemberOption[];
  circles: Array<{ id: string; name: string }>;
}) {
  const requestMemberOptions: MultiSelectFilterOption[] = memberOptions.map((member) => ({
    value: member.id,
    label: member.label,
  }));

  return (
    <>
      <label>
        Audience
        <select name="requestAudienceType" defaultValue="WORKSPACE">
          <option value="WORKSPACE">Workspace</option>
          <option value="MEMBERS">Selected people</option>
          <option value="CIRCLE">Circle</option>
        </select>
      </label>
      <MultiSelectFilter
        name="requestMemberIds"
        label="People"
        options={requestMemberOptions}
        allLabel="Choose people"
        selectAllLabel="Select all"
        unselectAllLabel="Unselect all"
        selectedCountLabel="{count} selected"
        collapseAllToEmpty={false}
        className="nr-advice-recipient-picker"
      />
      <label>
        Circle
        <select name="requestTargetCircleId" defaultValue="">
          <option value="">None</option>
          {circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}
        </select>
      </label>
      <label>
        {messageLabel}
        <MarkdownEditor name="requestMessageMd" rows={4} />
      </label>
      <div className="actions-inline">
        <label style={{ flex: 1 }}>
          Deadline
          <input name="requestDeadlineAt" type="datetime-local" />
        </label>
        <label style={{ flex: 1 }}>
          Reminder
          <input name="requestReminderAt" type="datetime-local" />
        </label>
      </div>
      <label>
        Preferred channel
        <select name="requestPreferredChannel" defaultValue="IN_APP">
          <option value="IN_APP">In app</option>
          <option value="SLACK">Slack</option>
          <option value="EMAIL">Email</option>
          <option value="COPY">Copy</option>
        </select>
      </label>
    </>
  );
}

function ActionChecklistCreateFields() {
  return (
    <label>
      Checklist items
      <textarea name="checklistItems" rows={4} placeholder="One item per line" />
    </label>
  );
}

function ProposalLinksCreateFields({
  sourceTensions,
  relatedActions,
}: {
  sourceTensions: Array<{ id: string; title: string }>;
  relatedActions: Array<{ id: string; title: string }>;
}) {
  return (
    <>
      <label>
        Source tension
        <select name="sourceTensionId" defaultValue="">
          <option value="">None</option>
          {sourceTensions.map((tension) => <option key={tension.id} value={tension.id}>{tension.title}</option>)}
        </select>
      </label>
      <label>
        Related actions
        <select
          name="relatedActionIds"
          multiple
          size={Math.min(5, Math.max(2, relatedActions.length || 1))}
        >
          {relatedActions.length === 0 && <option value="" disabled>No eligible actions</option>}
          {relatedActions.map((action) => <option key={action.id} value={action.id}>{action.title}</option>)}
        </select>
      </label>
    </>
  );
}

function CreateWorkItemFooter({
  draftLabel,
  openLabel,
  returnTo,
}: {
  draftLabel: string;
  openLabel: string;
  returnTo: string;
}) {
  return (
    <div className="actions-inline">
      <DuplicateGuardSubmitButton name="submitIntent" value="draft" className="secondary">{draftLabel}</DuplicateGuardSubmitButton>
      <DuplicateGuardSubmitButton name="submitIntent" value="open">{openLabel}</DuplicateGuardSubmitButton>
      {cancelLink(returnTo)}
    </div>
  );
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
  const canManagePracticeProjects = Boolean(featureFlags.FINANCE && featureFlags.PRACTICE_PROJECTS)
    && await canManagePracticeFinanceProjects(actor, workspaceId, {
      resolvedMembership: membership,
    });

  const returnTo = sanitizeWorkspaceReturnTo(workspaceId, search.returnTo);
  const contextCircleId = circleIdFromReturnTo(returnTo, workspaceId);
  const returnUrl = new URL(returnTo, "https://app.local");
  const contextRoleId = roleIdFromPath(returnUrl.pathname, workspaceId);
  const returnSubpath = workspaceSubpath(returnUrl.pathname, workspaceId);
  const isAgreementArticle = kind === "article"
    && (returnSubpath === "/agreements" || Boolean(returnSubpath?.startsWith("/agreements/")));
  const articleTypeOptions = isAgreementArticle ? AGREEMENT_ARTICLE_TYPES : ARTICLE_TYPES;
  const articleAuthorityOptions = isAgreementArticle ? AGREEMENT_ARTICLE_AUTHORITIES : ARTICLE_AUTHORITIES;
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
  const needsProposalLinks = kind === "proposal";
  const needsMembers = kind === "action"
    || kind === "tension"
    || kind === "proposal"
    || kind === "goal"
    || kind === "role_assignment"
    || kind === "deal"
    || kind === "crm_activity"
    || kind === "communication_suggestion";
  const needsCircles = kind === "action"
    || kind === "tension"
    || kind === "proposal"
    || kind === "goal"
    || kind === "circle"
    || kind === "role"
    || kind === "tool_link";
  const needsRoles = kind === "role_assignment";
  const needsGoals = kind === "goal";
  const needsContacts = kind === "deal" || kind === "crm_activity" || kind === "communication_suggestion";
  const needsAccounts = (kind === "crm_activity" || kind === "communication_suggestion") && !contextAccountId;
  const needsDeals = kind === "crm_activity" || kind === "communication_suggestion";
  const needsApprovedProspects = kind === "prospect_instance";

  const [
    proposalsResult,
    members,
    circles,
    goals,
    contactsResult,
    accountsResult,
    dealsResult,
    approvedQualificationsResult,
    roles,
    actionsResult,
    tensionsResult,
  ] = await Promise.all([
    needsProposals ? listProposals(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsMembers ? listHumanMembers(workspaceId) : Promise.resolve([]),
    needsCircles ? listCircles(workspaceId) : Promise.resolve([]),
    needsGoals ? listGoals(actor, { workspaceId }) : Promise.resolve([]),
    needsContacts ? listContacts(actor, workspaceId, { take: 100, accountId: contextAccountId ?? undefined }) : Promise.resolve({ items: [] }),
    needsAccounts ? listCrmAccounts(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsDeals ? listDeals(actor, workspaceId, { take: 100, accountId: contextAccountId ?? undefined }) : Promise.resolve({ items: [] }),
    needsApprovedProspects ? listQualifications(actor, workspaceId, { status: "APPROVED" }) : Promise.resolve({ items: [] }),
    needsRoles ? listRoles(workspaceId) : Promise.resolve([]),
    needsProposalLinks ? listActions(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsProposalLinks ? listTensions(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
  ]);

  const proposals = proposalsResult.items;
  const activeProposals = proposals.filter((proposal) => proposal.status === "DRAFT" || proposal.status === "OPEN");
  const proposalSourceTensions = tensionsResult.items.filter((tension) => (
    (tension.status === "DRAFT" || tension.status === "OPEN") && !tension.proposalId
  ));
  const proposalRelatedActions = actionsResult.items.filter((action) => (
    (action.status === "DRAFT" || action.status === "OPEN" || action.status === "IN_PROGRESS") && !action.proposalId
  ));
  const memberOptions: WorkItemMemberOption[] = members.map((member) => ({
    id: member.id,
    label: member.user.displayName ?? member.user.email,
  }));
  const actorMemberId = actor.kind === "user"
    ? members.find((member) => member.user.id === actor.user.id)?.id
    : null;
  const defaultProposalOwnerMemberId = actorMemberId
    ?? (membership?.id && memberOptions.some((member) => member.id === membership.id)
      ? membership.id
      : "");
  const contacts = contactsResult.items;
  const accounts = accountsResult.items;
  const deals = dealsResult.items;
  const approvedQualifications = approvedQualificationsResult.items;
  const roleAssignmentRoles = contextRoleId
    ? roles.filter((role) => role.id === contextRoleId)
    : contextCircleId
      ? roles.filter((role) => role.circle?.id === contextCircleId)
      : roles;
  const defaultRoleAssignmentRoleId = contextRoleId
    && roleAssignmentRoles.some((role) => role.id === contextRoleId)
    ? contextRoleId
    : roleAssignmentRoles[0]?.id ?? "";
  const title = kind === "meeting_manual_recording"
    ? "Record meeting now"
    : kind === "meeting_audio_upload"
      ? "Upload meeting audio"
    : kind === "upload_file"
      ? "Upload files from this device"
    : isAgreementArticle
      ? "Add working agreement"
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
    dueDate: "Due date",
    priorityLabel: "Priority",
    priority: DEFAULT_WORK_ITEM_PRIORITY_LABELS,
  };

  async function createActionAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      const workspaceId = asString(formData, "workspaceId");
      await enforceDemoGuard(workspaceId);
      const actor = await requirePageActor();
      const intent = createIntentFromForm(formData);
      const applyAddOns = shouldApplyCreateAddOns(formData);
      const requestAddOn = await validateCreateRequestAddOn(actor, {
        workspaceId,
        formData,
        intent,
        applyAddOns,
      });
      const action = await createAction(actor, {
        workspaceId,
        title: asString(formData, "title"),
        bodyMd: asOptional(formData, "bodyMd"),
        proposalId: asOptional(formData, "proposalId"),
        assigneeMemberId: asOptional(formData, "assigneeMemberId"),
        dueAt: formData.has("dueAt") ? asOptionalDate(formData, "dueAt") : undefined,
        priority: asOptionalInt(formData, "priority"),
        isPrivate: intent === "draft",
        duplicateGuard: duplicateGuardFromFormData(formData),
      });
      if (applyAddOns) {
        await maybeAttachCreateReference(actor, {
          workspaceId,
          entityType: "Action",
          entityId: action.id,
          formData,
        });
        await maybeCreateActionChecklist(actor, {
          workspaceId,
          actionId: action.id,
          formData,
          canEditChecklist: action.status === "DRAFT" || action.status === "OPEN" || action.status === "IN_PROGRESS",
        });
        await maybeCreateRequestFromForm(actor, {
          workspaceId,
          subjectType: "ACTION",
          subjectId: action.id,
          request: requestAddOn,
          canSendRequest: (action.status === "OPEN" || action.status === "IN_PROGRESS") && !action.isPrivate,
        });
      }
      refresh(workspaceId);
    } catch (error) {
      return duplicateGuardState(error, formData);
    }
    redirect(returnTo);
  }

  async function createTensionAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      const workspaceId = asString(formData, "workspaceId");
      await enforceDemoGuard(workspaceId);
      const actor = await requirePageActor();
      const intent = createIntentFromForm(formData);
      const applyAddOns = shouldApplyCreateAddOns(formData);
      const requestAddOn = await validateCreateRequestAddOn(actor, {
        workspaceId,
        formData,
        intent,
        applyAddOns,
      });
      const tension = await createTension(actor, {
        workspaceId,
        title: asString(formData, "title"),
        bodyMd: asOptional(formData, "bodyMd"),
        proposalId: asOptional(formData, "proposalId"),
        assigneeMemberId: asOptional(formData, "assigneeMemberId"),
        raisedByMemberId: asOptional(formData, "raisedByMemberId"),
        priority: asOptionalInt(formData, "priority"),
        isPrivate: intent === "draft",
        duplicateGuard: duplicateGuardFromFormData(formData),
      });
      if (applyAddOns) {
        await maybeAttachCreateReference(actor, {
          workspaceId,
          entityType: "Tension",
          entityId: tension.id,
          formData,
        });
        await maybeCreateRequestFromForm(actor, {
          workspaceId,
          subjectType: "TENSION",
          subjectId: tension.id,
          request: requestAddOn,
          canSendRequest: tension.status === "OPEN" && !tension.isPrivate,
        });
      }
      refresh(workspaceId);
    } catch (error) {
      return duplicateGuardState(error, formData);
    }
    redirect(returnTo);
  }

  async function createProposalAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      const workspaceId = asString(formData, "workspaceId");
      await enforceDemoGuard(workspaceId);
      const actor = await requirePageActor();
      const intent = createIntentFromForm(formData);
      const applyAddOns = shouldApplyCreateAddOns(formData);
      const requestAddOn = await validateCreateRequestAddOn(actor, {
        workspaceId,
        formData,
        intent,
        applyAddOns,
      });
      const ownerMemberId = formData.has("ownerMemberId") ? asOptional(formData, "ownerMemberId") : undefined;
      const proposal = await createProposal(actor, {
        workspaceId,
        title: asString(formData, "title"),
        summary: asOptional(formData, "summary"),
        bodyMd: asString(formData, "bodyMd"),
        includeAiSummary: formData.get("includeAiSummary") === "on",
        priority: asOptionalInt(formData, "priority"),
        ...(ownerMemberId !== undefined ? { ownerMemberId } : {}),
        isPrivate: intent === "draft",
        sourceTensionId: asOptional(formData, "sourceTensionId"),
        relatedActionIds: asStringArray(formData, "relatedActionIds"),
        duplicateGuard: duplicateGuardFromFormData(formData),
      });
      if (applyAddOns) {
        await maybeAttachCreateReference(actor, {
          workspaceId,
          entityType: "Proposal",
          entityId: proposal.id,
          formData,
        });
        await maybeCreateRequestFromForm(actor, {
          workspaceId,
          subjectType: "PROPOSAL",
          subjectId: proposal.id,
          request: requestAddOn,
          canSendRequest: proposal.status === "OPEN",
        });
      }
      refresh(workspaceId);
    } catch (error) {
      return duplicateGuardState(error, formData);
    }
    redirect(returnTo);
  }

  async function createGoalAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      await createGoalFormAction(formData);
    } catch (error) {
      return duplicateGuardState(error, formData);
    }
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

  async function createPracticeProjectAndReturn(formData: FormData) {
    "use server";
    await createPracticeProjectAction(formData);
    redirect(returnTo);
  }

  async function createArticleAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    try {
      await createArticleAction(formData);
    } catch (error) {
      return duplicateGuardState(error, formData);
    }
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

  async function pasteTextAndReturn(_state: DuplicateGuardFormState, formData: FormData): Promise<DuplicateGuardFormState> {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    const sourceType = asString(formData, "sourceType") as BrainSourceType;
    const content = asString(formData, "content");
    try {
      await ingestSource(actor, {
        workspaceId,
        sourceType,
        tier: 1,
        content,
        title: asOptional(formData, "title") ?? undefined,
        channel: asOptional(formData, "channel") ?? undefined,
        authorMemberId: membership?.id === "global-operator" ? null : membership?.id ?? null,
        ingestionGuidanceMd: asOptional(formData, "ingestionGuidanceMd"),
        duplicateGuard: duplicateGuardFromFormData(formData),
      });
    } catch (error) {
      return duplicateGuardState(error, formData);
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
            <label>Meeting URL<input name="meetingUrl" type="url" placeholder="https://teams.microsoft.com/meet/..." /></label>
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
          <MeetingTranscriptUploadForm
            workspaceId={workspaceId}
            className="stack nr-form-section"
            successHref={returnTo}
            showTitle
            showSource
            showRecordedAt
            requireRecordedAt
            showTimeZone
            showParticipants
            transcriptRows={8}
            labels={{
              title: "Title",
              source: "Source",
              recordedAt: "Recorded at",
              participantEmails: "Participant emails",
              participantEmailsPlaceholder: "one@example.com, two@example.com",
              ingestionGuidance: "Ingestion guidance",
              file: "Transcript file",
              transcript: "Transcript",
              submit: "Upload transcript",
              retrySubmit: "Continue",
              chooseMeeting: "Choose meeting",
              createNewMeeting: "None of these - create a new meeting",
              retryUpload: "Upload or paste the transcript again to continue.",
              cancel: "Cancel",
            }}
            cancelHref={returnTo}
          />
        )}

        {kind === "meeting_manual_recording" && (
          <ManualMeetingRecordingForm workspaceId={workspaceId} cancelHref={returnTo} />
        )}

        {kind === "meeting_audio_upload" && (
          <MeetingAudioUploadForm workspaceId={workspaceId} cancelHref={returnTo} />
        )}

        {kind === "action" && (
          <DuplicateGuardActionEditorForm
            action={createActionAndReturn}
            workspaceId={workspaceId}
            members={actionMembers}
            labels={actionEditorLabels}
            priority={1}
            cancelHref={returnTo}
            footer={<CreateWorkItemFooter draftLabel="Save draft" openLabel="Create action" returnTo={returnTo} />}
          >
            <label>
              Link to proposal
              <select name="proposalId" defaultValue="">
                <option value="">None</option>
                {activeProposals.map((proposal) => <option value={proposal.id} key={proposal.id}>{proposal.title}</option>)}
              </select>
            </label>
            <WorkItemAddOnSection title="References">
              <CreateReferenceFields />
            </WorkItemAddOnSection>
            <WorkItemAddOnSection title="Request input">
              <CreateRequestFields
                messageLabel="Input request"
                memberOptions={memberOptions}
                circles={circles}
              />
            </WorkItemAddOnSection>
            <WorkItemAddOnSection title="Checklist">
              <ActionChecklistCreateFields />
            </WorkItemAddOnSection>
          </DuplicateGuardActionEditorForm>
        )}

        {kind === "tension" && (
          <DuplicateGuardForm action={createTensionAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Description<MarkdownEditor name="bodyMd" rows={5} /></label>
            <WorkItemMemberSelect
              name="assigneeMemberId"
              label="Responsible person"
              noneLabel="No responsible person"
              members={memberOptions}
            />
            <WorkItemPrioritySelect label="Priority" labels={DEFAULT_WORK_ITEM_PRIORITY_LABELS} defaultValue={0} />
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
            <WorkItemAddOnSection title="References">
              <CreateReferenceFields />
            </WorkItemAddOnSection>
            <WorkItemAddOnSection title="Request input">
              <CreateRequestFields
                messageLabel="Input request"
                memberOptions={memberOptions}
                circles={circles}
              />
            </WorkItemAddOnSection>
            <CreateWorkItemFooter draftLabel="Save draft" openLabel="Create tension" returnTo={returnTo} />
          </DuplicateGuardForm>
        )}

        {kind === "proposal" && (
          <DuplicateGuardForm action={createProposalAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Summary<input name="summary" /></label>
            <label>Body<MarkdownEditor name="bodyMd" required rows={8} /></label>
            <WorkItemMemberSelect
              name="ownerMemberId"
              label="Owner"
              noneLabel="No owner"
              members={memberOptions}
              defaultValue={defaultProposalOwnerMemberId}
            />
            <WorkItemPrioritySelect label="Priority" labels={DEFAULT_WORK_ITEM_PRIORITY_LABELS} defaultValue={0} />
            <WorkItemAddOnSection title="Process links">
              <ProposalLinksCreateFields
                sourceTensions={proposalSourceTensions}
                relatedActions={proposalRelatedActions}
              />
            </WorkItemAddOnSection>
            <WorkItemAddOnSection title="References">
              <CreateReferenceFields />
            </WorkItemAddOnSection>
            <WorkItemAddOnSection title="Request advice">
              <CreateRequestFields
                messageLabel="Advice request"
                memberOptions={memberOptions}
                circles={circles}
              />
            </WorkItemAddOnSection>
            <CreateWorkItemFooter draftLabel="Save draft" openLabel="Open proposal" returnTo={returnTo} />
          </DuplicateGuardForm>
        )}

        {kind === "goal" && (
          <DuplicateGuardForm action={createGoalAndReturn} className="stack nr-form-section">
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
          </DuplicateGuardForm>
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
              <select name="roleId" required defaultValue={defaultRoleAssignmentRoleId}>
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

        {kind === "finance_project" && (
          <PracticeProjectAddPanel
            action={createPracticeProjectAndReturn}
            canManagePracticeProjects={canManagePracticeProjects}
            returnTo={returnTo}
            workspaceId={workspaceId}
          />
        )}

        {kind === "article" && (
          <DuplicateGuardForm action={createArticleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            {isAgreementArticle && <input type="hidden" name="agreementCapture" value="working-agreement" />}
            <label>Title<input name="title" required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>
                Type
                <select name="type" defaultValue={isAgreementArticle ? "PROCESS" : undefined}>
                  {articleTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                Authority
                <select name="authority" defaultValue={isAgreementArticle ? "REFERENCE" : "DRAFT"}>
                  {articleAuthorityOptions.map((authority) => (
                    <option key={authority} value={authority}>{ARTICLE_AUTHORITY_LABELS[authority]}</option>
                  ))}
                </select>
              </label>
            </div>
            {isAgreementArticle && (
              <>
                <label>Source<input name="agreementSource" /></label>
                <label>Context<MarkdownEditor name="agreementContext" rows={4} /></label>
              </>
            )}
            <label>Body<MarkdownEditor name="bodyMd" required rows={8} /></label>
            {!isAgreementArticle && (
              <label style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}>
                <input type="checkbox" name="isPrivate" defaultChecked style={{ width: "auto" }} />
                Private draft
              </label>
            )}
            <div className="actions-inline"><button type="submit">{isAgreementArticle ? "Create working agreement" : "Create article"}</button>{cancelLink(returnTo)}</div>
          </DuplicateGuardForm>
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
          <PasteTextForm
            workspaceId={workspaceId}
            sourceTypes={SOURCE_TYPES}
            ingestAction={pasteTextAndReturn}
            cancelHref={returnTo}
          />
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
