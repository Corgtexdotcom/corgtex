import type { BrainArticleType, BrainSourceType, GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";
import { notFound, redirect } from "next/navigation";
import {
  createCatalogRequest,
  createExternalDataSource,
  createWorkspaceToolLink,
  getMeetingRecorderConfig,
  getMemberInvitePolicy,
  ingestSource,
  intakeMeetingTranscript,
  listCircles,
  listContacts,
  listCycles,
  listGoals,
  listLedgerAccounts,
  listMembers,
  listProposals,
  listQualifications,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { ingestFile } from "@corgtex/knowledge";
import { encrypt } from "@corgtex/connectors-sql";
import { prisma } from "@corgtex/shared";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import {
  getWorkspaceAddActions,
  isWorkspaceAddActionKind,
  sanitizeWorkspaceReturnTo,
  WORKSPACE_ADD_ACTION_DEFINITIONS,
  type WorkspaceAddActionKind,
} from "@/lib/workspace-add-actions";
import {
  bulkInviteAction,
  createActionAction,
  createAllocationAction,
  createCircleAction,
  createContactAction,
  createCycleAction,
  createDealAction,
  createLedgerAccountAction,
  createMeetingSeriesAction,
  createMemberAction,
  createProposalAction,
  createRoleAction,
  createSpendAction,
  createTensionAction,
  createWebhookEndpointAction,
  importMeetingInviteAction,
  inviteMemberAction,
  provisionProspectWorkspaceAction,
  requestMemberInviteAction,
  scheduleManualMeetingRecordingAction,
  uploadMeetingTranscriptAction,
} from "../actions";
import { createArticleAction } from "../brain/actions";
import { createGoalFormAction } from "../goals/actions";
import { asOptional, asOptionalInt, asString, refresh } from "../action-utils";

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
const SOURCE_TYPES: BrainSourceType[] = ["MEETING", "TICKET", "PR", "RFC", "INCIDENT", "SLACK", "CUSTOMER_FEEDBACK", "COMPETITOR", "RESEARCH", "ARTICLE", "DOC", "RUNBOOK", "EMAIL", "FILE_UPLOAD"];
const LOCAL_DATETIME_OFFSET_SCRIPT = `
(() => {
  const script = document.currentScript;
  const form = script?.closest("form");
  const pairs = [
    [form?.querySelector('input[name="joinAt"]'), form?.querySelector('input[name="joinAtTimezoneOffsetMinutes"]')],
    [form?.querySelector('input[name="scheduledEndAt"]'), form?.querySelector('input[name="scheduledEndAtTimezoneOffsetMinutes"]')],
  ];
  const sync = (input, offset) => {
    if (!(input instanceof HTMLInputElement) || !(offset instanceof HTMLInputElement)) return;
    offset.value = input.value ? String(new Date(input.value).getTimezoneOffset()) : String(new Date().getTimezoneOffset());
  };
  for (const [input, offset] of pairs) {
    if (!(input instanceof HTMLInputElement) || !(offset instanceof HTMLInputElement)) continue;
    const update = () => sync(input, offset);
    input.addEventListener("input", update);
    input.addEventListener("change", update);
    update();
  }
})();
`;

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
  const returnUrl = new URL(returnTo, "https://app.local");
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
  const needsMembers = kind === "tension" || kind === "goal" || kind === "allocation";
  const needsCircles = kind === "goal" || kind === "circle" || kind === "role" || kind === "tool_link";
  const needsGoals = kind === "goal";
  const needsLedgerAccounts = kind === "spend";
  const needsContacts = kind === "deal";
  const needsCycles = kind === "allocation";
  const needsApprovedProspects = kind === "prospect_instance";

  const [
    proposalsResult,
    members,
    circles,
    goals,
    ledgerAccountsResult,
    contactsResult,
    cyclesResult,
    approvedQualificationsResult,
  ] = await Promise.all([
    needsProposals ? listProposals(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsMembers ? listMembers(workspaceId) : Promise.resolve([]),
    needsCircles ? listCircles(workspaceId) : Promise.resolve([]),
    needsGoals ? listGoals(actor, { workspaceId }) : Promise.resolve([]),
    needsLedgerAccounts ? listLedgerAccounts(workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsContacts ? listContacts(actor, workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsCycles ? listCycles(workspaceId, { take: 100 }) : Promise.resolve({ items: [] }),
    needsApprovedProspects ? listQualifications(actor, workspaceId, { status: "APPROVED" }) : Promise.resolve({ items: [] }),
  ]);

  const proposals = proposalsResult.items;
  const activeProposals = proposals.filter((proposal) => proposal.status === "DRAFT" || proposal.status === "OPEN");
  const ledgerAccounts = ledgerAccountsResult.items;
  const contacts = contactsResult.items;
  const cycles = cyclesResult.items;
  const allocatableCycles = cycles.filter((cycle) => cycle.status === "OPEN_ALLOCATIONS");
  const approvedQualifications = approvedQualificationsResult.items;
  const currentUserId = actor.kind === "user" ? actor.user.id : "";
  const title = `Add ${WORKSPACE_ADD_ACTION_DEFINITIONS[kind].label}`;

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

  async function createSpendAndReturn(formData: FormData) {
    "use server";
    await createSpendAction(formData);
    redirect(returnTo);
  }

  async function createLedgerAccountAndReturn(formData: FormData) {
    "use server";
    await createLedgerAccountAction(formData);
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

  async function recordMeetingManuallyAndReturn(formData: FormData) {
    "use server";
    await scheduleManualMeetingRecordingAction(formData);
    redirect(returnTo);
  }

  async function createContactAndReturn(formData: FormData) {
    "use server";
    await createContactAction(formData);
    redirect(returnTo);
  }

  async function createDealAndReturn(formData: FormData) {
    "use server";
    await createDealAction(formData);
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

  async function uploadFileAndReturn(formData: FormData) {
    "use server";
    const workspaceId = asString(formData, "workspaceId");
    await enforceDemoGuard(workspaceId);
    const actor = await requirePageActor();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new Error("File is required.");
    }
    await ingestFile(actor, {
      workspaceId,
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      uploadSource: asOptional(formData, "source") ?? "settings-upload",
      documentTitle: asOptional(formData, "title") ?? file.name,
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
        recordedAt: asOptional(formData, "recordedAt"),
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
              <label style={{ flex: 1 }}>Scheduled end<input name="scheduledEndAt" type="datetime-local" /></label>
            </div>
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
            <label>Participant emails<input name="participantEmails" placeholder="one@example.com, two@example.com" /></label>
            <label>Ingestion guidance<MarkdownEditor name="ingestionGuidanceMd" rows={3} /></label>
            <label>Transcript file<input name="file" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" /></label>
            <label>Transcript<textarea name="transcript" rows={8} /></label>
            <div className="actions-inline"><button type="submit">Upload transcript</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "meeting_manual_recording" && (
          <form action={recordMeetingManuallyAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Meeting URL<input name="meetingUrl" type="url" placeholder="https://teams.microsoft.com/l/meetup-join/..." required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Meeting time<input name="joinAt" type="datetime-local" required /></label>
              <label style={{ flex: 1 }}>Ends at<input name="scheduledEndAt" type="datetime-local" /></label>
            </div>
            <input name="joinAtTimezoneOffsetMinutes" type="hidden" value="0" />
            <input name="scheduledEndAtTimezoneOffsetMinutes" type="hidden" value="0" />
            <script dangerouslySetInnerHTML={{ __html: LOCAL_DATETIME_OFFSET_SCRIPT }} />
            <label>Participant emails<input name="participantEmails" placeholder="one@example.com, two@example.com" /></label>
            <div className="actions-inline"><button type="submit">Record meeting</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "action" && (
          <form action={createActionAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Notes<MarkdownEditor name="bodyMd" rows={5} /></label>
            <label>
              Link to proposal
              <select name="proposalId" defaultValue="">
                <option value="">None</option>
                {activeProposals.map((proposal) => <option value={proposal.id} key={proposal.id}>{proposal.title}</option>)}
              </select>
            </label>
            <div className="actions-inline"><button type="submit">Create action</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "tension" && (
          <form action={createTensionAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" required /></label>
            <label>Description<MarkdownEditor name="bodyMd" rows={5} /></label>
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
            <label style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: 8 }}>
              <input type="checkbox" name="isPrivate" defaultChecked style={{ width: "auto" }} />
              Private draft
            </label>
            <div className="actions-inline"><button type="submit">Create draft</button>{cancelLink(returnTo)}</div>
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

        {kind === "circle" && (
          <form action={createCircleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Name<input name="name" required /></label>
            <label>Parent circle<select name="parentCircleId"><option value="">None</option>{circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}</select></label>
            <label>Purpose<textarea name="purposeMd" /></label>
            <label>Domain<textarea name="domainMd" /></label>
            <div className="actions-inline"><button type="submit">Create circle</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "role" && (
          <form action={createRoleAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Circle<select name="circleId" required defaultValue={circles[0]?.id ?? ""}>{circles.map((circle) => <option key={circle.id} value={circle.id}>{circle.name}</option>)}</select></label>
            <label>Name<input name="name" required /></label>
            <label>Purpose<textarea name="purposeMd" /></label>
            <label>Accountabilities<textarea name="accountabilities" placeholder="One accountability per line" /></label>
            <div className="actions-inline"><button type="submit" disabled={circles.length === 0}>Create role</button>{cancelLink(returnTo)}</div>
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

        {kind === "spend" && (
          <form action={createSpendAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Amount<input name="amount" type="number" step="0.01" min="0.01" required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Currency<input name="currency" defaultValue="USD" required /></label>
              <label style={{ flex: 1 }}>Category<input name="category" required /></label>
            </div>
            <label>Description<textarea name="description" required /></label>
            <label>Vendor<input name="vendor" /></label>
            <label>Ledger account<select name="ledgerAccountId" defaultValue=""><option value="">Unassigned</option>{ledgerAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>)}</select></label>
            <div className="actions-inline"><button type="submit">Create spend</button>{cancelLink(returnTo)}</div>
          </form>
        )}

        {kind === "ledger_account" && (
          <form action={createLedgerAccountAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Name<input name="name" required /></label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>Currency<input name="currency" defaultValue="USD" required /></label>
              <label style={{ flex: 1 }}>Type<input name="type" defaultValue="MANUAL" /></label>
            </div>
            <label>Opening balance cents<input name="balanceCents" type="number" defaultValue={0} /></label>
            <div className="actions-inline"><button type="submit">Create account</button>{cancelLink(returnTo)}</div>
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

        {kind === "contact" && (
          <form action={createContactAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
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
            <label>Contact<select name="contactId" required><option value="">Choose contact</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}</select></label>
            <label>Deal title<input type="text" name="title" required /></label>
            <label>Value<input type="number" name="value" step="0.01" min="0" /></label>
            <div className="actions-inline"><button type="submit" disabled={contacts.length === 0}>Create deal</button>{cancelLink(returnTo)}</div>
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
          <form action={uploadFileAndReturn} className="stack nr-form-section">
            {hiddenWorkspace(workspaceId)}
            <label>Title<input name="title" /></label>
            <label>Source<input name="source" defaultValue="settings-upload" /></label>
            <label>File<input name="file" type="file" required /></label>
            <div className="actions-inline"><button type="submit">Upload file</button>{cancelLink(returnTo)}</div>
          </form>
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
