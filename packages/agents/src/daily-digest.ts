import { env, logger, prisma, sendEmail } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import {
  AGENT_REGISTRY,
  getAgentModelOverride,
  getWorkspaceNewspaperCadence,
  instrumentNewspaperHtmlLinks,
  isHumanNewspaperRecipientIdentity,
  normalizeNewspaperCadence,
  recordNewspaperDelivery,
  recordDemoWelcomeCrmActivity,
  buildWorkspaceBriefingFromCandidates,
  buildWorkspaceBriefingFromDigest,
  collectWorkspaceBriefingCandidates,
  renderWorkspaceBriefingMarkdown,
  upsertNewspaperEdition,
  upsertWorkspaceBriefing,
  workspaceBriefingContextSince,
  workspaceBriefingPeriodFromCadence,
  workspaceBriefingToNewspaperDigest,
} from "@corgtex/domain";
import { 
  batchIngestDailyConversations, 
  createArticle, 
  listSlackMessagesForDigest,
  updateArticle, 
  rebuildBacklinks 
} from "@corgtex/domain";
import type { BrainArticleType, NewspaperCadence } from "@prisma/client";
import {
  normalizeNewspaperDigestPayload,
  normalizeNewspaperPersonalizationPayload,
  renderNewspaperDigestMarkdown,
  renderWorkspaceBriefingEmailHtml,
  withNewspaperAdviceRequests,
} from "./newspaper-email";

type DeliveryCadence = Exclude<NewspaperCadence, "OFF">;

const LOOKBACK_DAYS_BY_CADENCE: Record<DeliveryCadence, number> = {
  DAILY: 1,
  WEEKLY: 7,
};

function cadenceLabel(cadence: NewspaperCadence) {
  return cadence === "WEEKLY" ? "Weekly" : "Daily";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function workspaceUrl(workspaceId: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/workspaces/${workspaceId}`;
}

function isDeliveryCadence(cadence: NewspaperCadence): cadence is DeliveryCadence {
  return cadence === "DAILY" || cadence === "WEEKLY";
}

export function buildDemoWelcomeNewspaperHtml(params?: { workspaceName?: string | null }) {
  const workspaceName = escapeHtml(params?.workspaceName?.trim() || "Corgtex");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f1ea;color:#1f1d1a;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ea;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fffaf0;border:1px solid #2d2a24;">
            <tr>
              <td style="padding:24px 28px 12px;border-bottom:3px double #2d2a24;text-align:center;">
                <div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;">The ${workspaceName} Edition</div>
                <h1 style="font-size:34px;line-height:1.05;margin:8px 0 6px;font-weight:700;">Welcome to Corgtex</h1>
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;">A first look at your operating picture</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <h2 style="font-size:22px;line-height:1.2;margin:0 0 12px;">What Corgtex helps your team do</h2>
                <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">Welcome. This first newspaper is meant to make Corgtex concrete: one calm place to see what is happening, what has been decided, what needs attention, and where work is moving. The goal is not to add another inbox. It is to help your team adopt AI while keeping ownership of context, decisions, handoffs, and human review.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #2d2a24;border-bottom:1px solid #2d2a24;margin:20px 0;">
                  <tr>
                    <td style="padding:16px 0;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Shared company memory</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Important context from conversations, documents, decisions, and operating history becomes easier to find and easier to trust.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Decision visibility</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Proposals, approvals, objections, and advice records stay visible so teams know why a choice was made and what changed afterward.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Follow-through on work</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Actions, tensions, meetings, goals, and shipped work can be summarized into a practical newspaper that tells each member what matters next.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Business visibility</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Finance, budget, and operating activity can live beside the work itself, helping leaders see cost, value, and progress in one operating picture.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 0;border-top:1px solid #c9c0aa;">
                      <h3 style="font-size:16px;line-height:1.3;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.8px;">Ownership and control</h3>
                      <p style="font-size:15px;line-height:1.55;margin:0;">Especially for employee-owned, self-managed, or mission-driven teams, AI should strengthen trust and accountability rather than hide how work gets done.</p>
                    </td>
                  </tr>
                </table>
                <h2 style="font-size:22px;line-height:1.2;margin:0 0 12px;">What to try first</h2>
                <p style="font-size:16px;line-height:1.6;margin:0;">Open the workspace, read the newspaper, then look at the source items behind it. You can add company context to the Organization Brain, invite the people who should share the picture, capture meetings, track actions, and use governance workflows when decisions need a visible path.</p>
                <p style="font-size:15px;line-height:1.6;margin:20px 0 0;"><a href="${env.APP_URL.replace(/\/$/, "")}" style="color:#2d2a24;text-decoration:underline;">Open Corgtex</a> when you are ready to see the operating picture behind the newspaper.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

type BuildArtifactDigestItem = {
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  branchName: string | null;
  title: string;
  summaryMd: string | null;
  status: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
  assets: {
    kind: string;
    label: string;
    captionMd: string | null;
  }[];
};

type DigestRecipientMember = {
  id: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  newspaperCadence?: NewspaperCadence | null;
  roleAssignments?: Array<{
    role?: {
      circleId: string;
      archivedAt: Date | null;
      circle?: {
        workspaceId: string;
        archivedAt: Date | null;
      } | null;
    } | null;
  }>;
};

type PendingAdviceDigestRequest = {
  id: string;
  audienceType: "MEMBERS" | "CIRCLE" | "WORKSPACE";
  targetCircleId: string | null;
  messageMd: string;
  deadlineAt: Date | null;
  reminderAt: Date | null;
  preferredChannel: "IN_APP" | "SLACK" | "EMAIL" | "COPY";
  createdAt: Date;
  requestedBy: {
    email: string;
    displayName: string | null;
  };
  targetCircle: {
    name: string;
  } | null;
  recipients: Array<{ memberId: string }>;
  process: {
    subjectType: string;
    subjectId: string;
  };
};

type AdviceSubjectPreview = {
  type: "PROPOSAL" | "TENSION" | "ACTION";
  id: string;
  title: string;
};

type OperatingDigestInputs = {
  meetings: Array<{
    id: string;
    title: string | null;
    recordedAt: Date;
    summaryMd: string | null;
    decisionsJson: unknown;
    participantEmails: string[];
    insights: Array<{
      type: string;
      operation: string;
      status: string;
      title: string;
      bodyMd: string;
      dueAt: Date | null;
    }>;
  }>;
  proposals: Array<{
    id: string;
    title: string;
    summary: string | null;
    status: string;
    resolutionOutcome: string | null;
    decisionMd: string | null;
    decidedAt: Date | null;
    updatedAt: Date;
    createdAt: Date;
  }>;
  resolvedTensions: Array<{
    id: string;
    title: string;
    status: string;
    resolvedVia: string | null;
    resolvedAt: Date | null;
    priority: number;
    updatedAt: Date;
  }>;
  openActions: Array<{
    id: string;
    title: string;
    bodyMd: string | null;
    status: string;
    assigneeMemberId: string | null;
    dueAt: Date | null;
    priority: number;
    updatedAt: Date;
  }>;
  goals: Array<{
    id: string;
    title: string;
    status: string;
    cadence: string;
    progressPercent: number;
    targetDate: Date | null;
    updatedAt: Date;
    updates: Array<{
      bodyMd: string;
      newProgress: number | null;
      statusChange: string | null;
      createdAt: Date;
    }>;
  }>;
  roleVersions: Array<{
    id: string;
    name: string;
    changeType: string;
    createdAt: Date;
  }>;
  roleHolderHistory: Array<{
    id: string;
    holderKind: string;
    startedAt: Date;
    endedAt: Date | null;
    role: { name: string };
    member: { user: { email: string; displayName: string | null } } | null;
  }>;
  newMembers: Array<{
    id: string;
    joinedAt: Date;
    user: { email: string; displayName: string | null };
  }>;
  brainArticles: Array<{
    id: string;
    title: string;
    type: string;
    authority: string;
    updatedAt: Date;
    publishedAt: Date | null;
  }>;
  documents: Array<{
    id: string;
    title: string;
    source: string;
    updatedAt: Date;
  }>;
  workspaceAdviceRequests: Array<{
    id: string;
    messageMd: string;
    status: string;
    deadlineAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    process: {
      subjectType: string;
      subjectId: string;
    };
    subjectPreview: AdviceSubjectPreview | null;
    subjectUrl: string | null;
  }>;
};

type DigestSourceCounts = {
  meetings: number;
  proposals: number;
  resolvedTensions: number;
  openActions: number;
  goals: number;
  roleChanges: number;
  roleHolderChanges: number;
  newMembers: number;
  brainArticles: number;
  documents: number;
  adviceRequests: number;
  conversations: number;
  slackMessages: number;
  buildArtifacts: number;
};

function formatBuildArtifactDate(value: Date | null) {
  return value ? value.toISOString().split("T")[0] : "unknown date";
}

function formatBuildArtifactDigestItem(item: BuildArtifactDigestItem) {
  const repo = `${item.repositoryOwner}/${item.repositoryName}`;
  const pr = item.pullRequestNumber ? `#${item.pullRequestNumber}` : "unlinked PR";
  const proof = item.assets.length > 0
    ? item.assets.map((asset) => `${asset.label} (${asset.kind})${asset.captionMd ? `: ${asset.captionMd}` : ""}`).join("; ")
    : "No visual proof attached yet.";

  return [
    `- ${item.title} (${repo} ${pr})`,
    item.pullRequestUrl ? `  PR: ${item.pullRequestUrl}` : null,
    item.branchName ? `  Branch: ${item.branchName}` : null,
    `  Last activity: ${formatBuildArtifactDate(item.updatedAt)}`,
    item.mergedAt ? `  Merged: ${formatBuildArtifactDate(item.mergedAt)}` : null,
    item.closedAt && item.status === "CLOSED" ? `  Closed: ${formatBuildArtifactDate(item.closedAt)}` : null,
    item.summaryMd ? `  Plan / description: ${item.summaryMd.slice(0, 800)}` : null,
    `  Visual proof: ${proof}`,
  ].filter(Boolean).join("\n");
}

function formatBuildArtifactDigestInput(items: BuildArtifactDigestItem[]) {
  const active = items.filter((item) => item.status === "OPEN");
  const merged = items.filter((item) => item.status === "MERGED");
  const closed = items.filter((item) => item.status === "CLOSED");
  const sections = [
    active.length > 0 ? `Active PR work:\n${active.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
    merged.length > 0 ? `Merged PRs / shipped outcomes:\n${merged.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
    closed.length > 0 ? `Closed without merge:\n${closed.map(formatBuildArtifactDigestItem).join("\n\n")}` : null,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function formatDigestDate(value: Date | null) {
  return value ? value.toISOString().split("T")[0] : null;
}

function compactDigestLine(value: string | null | undefined, maxLength = 700) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function stringifyDecisionValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return compactDigestLine(value, 600);
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const title = typeof record.title === "string" ? record.title : null;
        const summary = typeof record.summary === "string"
          ? record.summary
          : typeof record.body === "string"
            ? record.body
            : typeof record.text === "string"
              ? record.text
              : null;
        return [compactDigestLine([title, summary].filter(Boolean).join(": "), 400)].filter(Boolean) as string[];
      }
      return [];
    });
    return items.length > 0 ? items.slice(0, 5).join("; ") : null;
  }
  if (typeof value === "object") {
    return compactDigestLine(JSON.stringify(value), 600);
  }
  return null;
}

function sourceCountsLine(counts: DigestSourceCounts) {
  return [
    `meetings=${counts.meetings}`,
    `proposals=${counts.proposals}`,
    `resolvedTensions=${counts.resolvedTensions}`,
    `openActions=${counts.openActions}`,
    `goals=${counts.goals}`,
    `roleChanges=${counts.roleChanges}`,
    `roleHolderChanges=${counts.roleHolderChanges}`,
    `newMembers=${counts.newMembers}`,
    `brainArticles=${counts.brainArticles}`,
    `documents=${counts.documents}`,
    `adviceRequests=${counts.adviceRequests}`,
    `conversations=${counts.conversations}`,
    `slackMessages=${counts.slackMessages}`,
    `buildArtifacts=${counts.buildArtifacts}`,
  ].join(", ");
}

function hasDigestSourceInputs(counts: DigestSourceCounts) {
  return Object.values(counts).some((count) => count > 0);
}

function formatMeetingDigestInput(meetings: OperatingDigestInputs["meetings"]) {
  return meetings.map((meeting) => {
    const date = formatDigestDate(meeting.recordedAt) ?? "unknown date";
    const title = meeting.title?.trim() || "Untitled meeting";
    const decisions = stringifyDecisionValue(meeting.decisionsJson);
    const insights = meeting.insights.slice(0, 5).map((insight) => {
      const due = formatDigestDate(insight.dueAt);
      return `${insight.type} ${insight.operation} ${insight.status}: ${insight.title}${due ? ` (due ${due})` : ""}${compactDigestLine(insight.bodyMd, 240) ? ` - ${compactDigestLine(insight.bodyMd, 240)}` : ""}`;
    }).join("; ");
    return [
      `- ${title} (${date})`,
      compactDigestLine(meeting.summaryMd, 1200) ? `  Summary: ${compactDigestLine(meeting.summaryMd, 1200)}` : null,
      decisions ? `  Decisions: ${decisions}` : null,
      insights ? `  Suggested/linked operating items: ${insights}` : null,
      meeting.participantEmails.length > 0 ? `  Participants: ${meeting.participantEmails.slice(0, 8).join(", ")}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatProposalDigestInput(proposals: OperatingDigestInputs["proposals"]) {
  return proposals.map((proposal) => {
    const decided = formatDigestDate(proposal.decidedAt);
    return [
      `- ${proposal.title} (${proposal.status}${proposal.resolutionOutcome ? `, ${proposal.resolutionOutcome}` : ""})`,
      compactDigestLine(proposal.summary, 500) ? `  Summary: ${compactDigestLine(proposal.summary, 500)}` : null,
      compactDigestLine(proposal.decisionMd, 500) ? `  Decision: ${compactDigestLine(proposal.decisionMd, 500)}` : null,
      decided ? `  Decided: ${decided}` : `  Updated: ${formatDigestDate(proposal.updatedAt)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatResolvedTensionDigestInput(tensions: OperatingDigestInputs["resolvedTensions"]) {
  return tensions.map((tension) => [
    `- ${tension.title}`,
    `  Resolved: ${formatDigestDate(tension.resolvedAt) ?? formatDigestDate(tension.updatedAt) ?? "unknown date"}`,
    tension.resolvedVia ? `  Via: ${tension.resolvedVia}` : null,
    tension.priority > 0 ? `  Priority: ${tension.priority}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatOpenActionDigestInput(actions: OperatingDigestInputs["openActions"]) {
  return actions.map((action) => {
    const due = formatDigestDate(action.dueAt);
    return [
      `- ${action.title} (${action.status})`,
      compactDigestLine(action.bodyMd, 450) ? `  Detail: ${compactDigestLine(action.bodyMd, 450)}` : null,
      action.assigneeMemberId ? `  Assignee member ID: ${action.assigneeMemberId}` : null,
      due ? `  Due: ${due}` : null,
      action.priority > 0 ? `  Priority: ${action.priority}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatGoalDigestInput(goals: OperatingDigestInputs["goals"]) {
  return goals.map((goal) => {
    const updates = goal.updates.slice(0, 3).map((update) => {
      const progress = update.newProgress !== null ? ` progress ${update.newProgress}%` : "";
      const status = update.statusChange ? ` status ${update.statusChange}` : "";
      return `${formatDigestDate(update.createdAt)}:${progress}${status} ${compactDigestLine(update.bodyMd, 300) ?? ""}`.trim();
    }).join("; ");
    return [
      `- ${goal.title} (${goal.cadence}, ${goal.status}, ${goal.progressPercent}% complete)`,
      goal.targetDate ? `  Target: ${formatDigestDate(goal.targetDate)}` : null,
      updates ? `  Recent updates: ${updates}` : `  Updated: ${formatDigestDate(goal.updatedAt)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatRolesAndPeopleDigestInput(inputs: Pick<OperatingDigestInputs, "roleVersions" | "roleHolderHistory" | "newMembers">) {
  const roleChanges = inputs.roleVersions.map((role) => `- Role ${role.changeType.toLowerCase()}: ${role.name} (${formatDigestDate(role.createdAt)})`);
  const holderChanges = inputs.roleHolderHistory.map((history) => {
    const holder = history.member?.user.displayName || history.member?.user.email || history.holderKind.toLowerCase();
    const ended = history.endedAt ? `ended ${formatDigestDate(history.endedAt)}` : `started ${formatDigestDate(history.startedAt)}`;
    return `- Role holder ${ended}: ${holder} in ${history.role.name}`;
  });
  const people = inputs.newMembers.map((member) => (
    `- New member: ${member.user.displayName || member.user.email} joined ${formatDigestDate(member.joinedAt)}`
  ));
  return [...roleChanges, ...holderChanges, ...people].join("\n");
}

function formatBrainAndDocumentDigestInput(inputs: Pick<OperatingDigestInputs, "brainArticles" | "documents">) {
  const brain = inputs.brainArticles.map((article) => (
    `- Brain article: ${article.title} (${article.type}, ${article.authority}, updated ${formatDigestDate(article.updatedAt)})`
  ));
  const docs = inputs.documents.map((document) => (
    `- Document: ${document.title} (${document.source}, updated ${formatDigestDate(document.updatedAt)})`
  ));
  return [...brain, ...docs].join("\n");
}

function validAdviceSubjectType(value: string): AdviceSubjectPreview["type"] | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === "PROPOSAL" || normalized === "TENSION" || normalized === "ACTION") return normalized;
  return null;
}

function formatAdviceDigestDate(value: Date | null) {
  return value ? value.toISOString().split("T")[0] : null;
}

function truncateDigestText(value: string, maxLength = 360) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function adviceSubjectLabel(type: AdviceSubjectPreview["type"]) {
  if (type === "PROPOSAL") return "Proposal";
  if (type === "TENSION") return "Tension";
  return "Action";
}

function adviceRequestLabel(type: AdviceSubjectPreview["type"]) {
  return type === "PROPOSAL" ? "Advice request" : "Input request";
}

function adviceSubjectUrl(workspaceId: string, subject: AdviceSubjectPreview) {
  const baseUrl = workspaceUrl(workspaceId);
  if (subject.type === "PROPOSAL") return `${baseUrl}/proposals/${subject.id}`;
  if (subject.type === "TENSION") return `${baseUrl}/tensions/${subject.id}`;
  return `${baseUrl}/actions/${subject.id}`;
}

function adviceAudienceLabel(request: PendingAdviceDigestRequest) {
  if (request.audienceType === "WORKSPACE") return "Everyone";
  if (request.audienceType === "CIRCLE") return request.targetCircle?.name ? `${request.targetCircle.name} circle` : "Selected circle";
  return "Selected people";
}

function memberCircleIds(member: DigestRecipientMember, workspaceId: string) {
  return new Set((member.roleAssignments ?? []).flatMap((assignment) => {
    const role = assignment.role;
    if (!role || role.archivedAt) return [];
    if (role.circle && (role.circle.workspaceId !== workspaceId || role.circle.archivedAt)) return [];
    return [role.circleId];
  }));
}

async function loadAdviceSubjectPreviews(
  workspaceId: string,
  requests: PendingAdviceDigestRequest[],
  options: { until?: Date } = {},
) {
  const byType = new Map<AdviceSubjectPreview["type"], Set<string>>();
  for (const request of requests) {
    const subjectType = validAdviceSubjectType(request.process.subjectType);
    if (!subjectType) continue;
    if (!byType.has(subjectType)) byType.set(subjectType, new Set());
    byType.get(subjectType)!.add(request.process.subjectId);
  }

  const previews = new Map<string, AdviceSubjectPreview>();
  const proposalIds = [...(byType.get("PROPOSAL") ?? [])];
  const tensionIds = [...(byType.get("TENSION") ?? [])];
  const actionIds = [...(byType.get("ACTION") ?? [])];
  const updatedBeforeCutoff = options.until ? { lte: options.until } : undefined;

  const [proposals, tensions, actions] = await Promise.all([
    proposalIds.length
      ? prisma.proposal.findMany({
          where: {
            workspaceId,
            id: { in: proposalIds },
            archivedAt: null,
            isPrivate: false,
            status: { not: "DRAFT" },
            ...(updatedBeforeCutoff ? { updatedAt: updatedBeforeCutoff } : {}),
          },
          select: { id: true, title: true },
        })
      : [],
    tensionIds.length
      ? prisma.tension.findMany({
          where: {
            workspaceId,
            id: { in: tensionIds },
            archivedAt: null,
            isPrivate: false,
            ...(updatedBeforeCutoff ? { updatedAt: updatedBeforeCutoff } : {}),
          },
          select: { id: true, title: true },
        })
      : [],
    actionIds.length
      ? prisma.action.findMany({
          where: {
            workspaceId,
            id: { in: actionIds },
            archivedAt: null,
            isPrivate: false,
            ...(updatedBeforeCutoff ? { updatedAt: updatedBeforeCutoff } : {}),
          },
          select: { id: true, title: true },
        })
      : [],
  ]);

  for (const proposal of proposals) previews.set(`PROPOSAL:${proposal.id}`, { type: "PROPOSAL", id: proposal.id, title: proposal.title });
  for (const tension of tensions) previews.set(`TENSION:${tension.id}`, { type: "TENSION", id: tension.id, title: tension.title });
  for (const action of actions) previews.set(`ACTION:${action.id}`, { type: "ACTION", id: action.id, title: action.title });
  return previews;
}

function formatPendingAdviceRequestDigestItem(params: {
  workspaceId: string;
  request: PendingAdviceDigestRequest;
  subject: AdviceSubjectPreview;
}) {
  const due = formatAdviceDigestDate(params.request.deadlineAt);
  const reminder = formatAdviceDigestDate(params.request.reminderAt);
  const requestedBy = params.request.requestedBy.displayName || params.request.requestedBy.email;
  const channel = params.request.preferredChannel.replace("_", " ").toLowerCase();
  const lines = [
    `${adviceRequestLabel(params.subject.type)}: ${adviceSubjectLabel(params.subject.type)} - ${params.subject.title}`,
    `Request: ${truncateDigestText(params.request.messageMd)}`,
    `Asked by: ${requestedBy}`,
    `Audience: ${adviceAudienceLabel(params.request)}`,
    due ? `Deadline: ${due}` : null,
    reminder ? `Reminder: ${reminder}` : null,
    `Preferred channel: ${channel}`,
    `Open: ${adviceSubjectUrl(params.workspaceId, params.subject)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function loadPendingAdviceRequestsByMember(params: {
  workspaceId: string;
  recipientMembers: DigestRecipientMember[];
}) {
  const recipientMemberIds = params.recipientMembers.map((member) => member.id);
  if (recipientMemberIds.length === 0) return new Map<string, string[]>();

  const recipientCircleIds = Array.from(new Set(params.recipientMembers.flatMap((member) => (
    [...memberCircleIds(member, params.workspaceId)]
  ))));

  const requests = await prisma.adviceRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "ACTIVE",
      OR: [
        {
          audienceType: "MEMBERS",
          recipients: {
            some: {
              memberId: { in: recipientMemberIds },
            },
          },
        },
        ...(recipientCircleIds.length > 0
          ? [{
              audienceType: "CIRCLE" as const,
              targetCircleId: { in: recipientCircleIds },
            }]
          : []),
      ],
    },
    include: {
      requestedBy: {
        select: {
          email: true,
          displayName: true,
        },
      },
      targetCircle: {
        select: {
          name: true,
        },
      },
      recipients: {
        select: {
          memberId: true,
        },
      },
      process: {
        select: {
          subjectType: true,
          subjectId: true,
        },
      },
    },
    orderBy: [
      { deadlineAt: "asc" },
      { createdAt: "desc" },
    ],
    take: 100,
  }) as PendingAdviceDigestRequest[];

  if (requests.length === 0) return new Map<string, string[]>();

  const subjectPreviews = await loadAdviceSubjectPreviews(params.workspaceId, requests);
  const itemsByMemberId = new Map<string, string[]>();
  const circleIdsByMemberId = new Map(params.recipientMembers.map((member) => [
    member.id,
    memberCircleIds(member, params.workspaceId),
  ]));

  for (const request of requests) {
    const subjectType = validAdviceSubjectType(request.process.subjectType);
    if (!subjectType) continue;
    const subject = subjectPreviews.get(`${subjectType}:${request.process.subjectId}`);
    if (!subject) continue;

    const explicitRecipientMemberIds = new Set(request.recipients.map((recipient) => recipient.memberId));
    for (const member of params.recipientMembers) {
      const isRecipient = (request.audienceType === "MEMBERS" && explicitRecipientMemberIds.has(member.id))
        || (request.audienceType === "CIRCLE" && request.targetCircleId !== null && (circleIdsByMemberId.get(member.id)?.has(request.targetCircleId) ?? false));
      if (!isRecipient) continue;

      const existing = itemsByMemberId.get(member.id) ?? [];
      existing.push(formatPendingAdviceRequestDigestItem({
        workspaceId: params.workspaceId,
        request,
        subject,
      }));
      itemsByMemberId.set(member.id, existing);
    }
  }

  return itemsByMemberId;
}

async function loadOperatingDigestInputs(params: {
  workspaceId: string;
  since: Date;
  until: Date;
}): Promise<OperatingDigestInputs> {
  const windowRange = { gte: params.since, lte: params.until };
  const beforeCutoff = { lte: params.until };
  const [
    meetings,
    proposals,
    resolvedTensions,
    openActions,
    goals,
    roleVersions,
    roleHolderHistory,
    newMembers,
    brainArticles,
    documents,
    activeWorkspaceAdviceRequests,
    completedWorkspaceAdviceRequests,
  ] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        createdAt: beforeCutoff,
        OR: [
          { recordedAt: windowRange },
          { updatedAt: windowRange },
          { summaryPostedAt: windowRange },
          { aiProcessedAt: windowRange },
        ],
      },
      orderBy: { recordedAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        recordedAt: true,
        summaryMd: true,
        decisionsJson: true,
        participantEmails: true,
        insights: {
          where: {
            status: { in: ["SUGGESTED", "CONFIRMED", "APPLIED"] },
            OR: [
              { createdAt: windowRange },
              { updatedAt: windowRange },
            ],
          },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          take: 10,
          select: {
            type: true,
            operation: true,
            status: true,
            title: true,
            bodyMd: true,
            dueAt: true,
          },
        },
      },
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { createdAt: windowRange },
          { updatedAt: windowRange },
          { publishedAt: windowRange },
          { decidedAt: windowRange },
        ],
      },
      orderBy: [{ decidedAt: "desc" }, { updatedAt: "desc" }],
      take: 30,
      select: {
        id: true,
        title: true,
        summary: true,
        status: true,
        resolutionOutcome: true,
        decisionMd: true,
        decidedAt: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    prisma.tension.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "RESOLVED",
        updatedAt: beforeCutoff,
        OR: [
          { resolvedAt: windowRange },
          { updatedAt: windowRange },
        ],
      },
      orderBy: [{ resolvedAt: "desc" }, { updatedAt: "desc" }],
      take: 30,
      select: {
        id: true,
        title: true,
        status: true,
        resolvedVia: true,
        resolvedAt: true,
        priority: true,
        updatedAt: true,
      },
    }),
    prisma.action.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { in: ["OPEN", "IN_PROGRESS"] },
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
      },
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }, { updatedAt: "desc" }],
      take: 50,
      select: {
        id: true,
        title: true,
        bodyMd: true,
        status: true,
        assigneeMemberId: true,
        dueAt: true,
        priority: true,
        updatedAt: true,
      },
    }),
    prisma.goal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { not: "DRAFT" },
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { updatedAt: windowRange },
          { status: { in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] } },
        ],
      },
      orderBy: [{ cadence: "asc" }, { updatedAt: "desc" }],
      take: 25,
      select: {
        id: true,
        title: true,
        status: true,
        cadence: true,
        progressPercent: true,
        targetDate: true,
        updatedAt: true,
        updates: {
          where: { createdAt: windowRange },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: {
            bodyMd: true,
            newProgress: true,
            statusChange: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.roleVersion.findMany({
      where: {
        workspaceId: params.workspaceId,
        createdAt: windowRange,
      },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        name: true,
        changeType: true,
        createdAt: true,
      },
    }),
    prisma.roleHolderHistory.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { startedAt: windowRange },
          { endedAt: windowRange },
        ],
      },
      orderBy: { startedAt: "desc" },
      take: 25,
      select: {
        id: true,
        holderKind: true,
        startedAt: true,
        endedAt: true,
        role: { select: { name: true } },
        member: {
          select: {
            user: { select: { email: true, displayName: true } },
          },
        },
      },
    }),
    prisma.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        joinedAt: windowRange,
      },
      orderBy: { joinedAt: "desc" },
      take: 25,
      select: {
        id: true,
        joinedAt: true,
        user: { select: { email: true, displayName: true } },
      },
    }),
    prisma.brainArticle.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        type: { not: "DIGEST" },
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { createdAt: windowRange },
          { updatedAt: windowRange },
          { publishedAt: windowRange },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        title: true,
        type: true,
        authority: true,
        updatedAt: true,
        publishedAt: true,
      },
    }),
    prisma.document.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { createdAt: windowRange },
          { updatedAt: windowRange },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        title: true,
        source: true,
        updatedAt: true,
      },
    }),
    prisma.adviceRequest.findMany({
      where: {
        workspaceId: params.workspaceId,
        audienceType: "WORKSPACE",
        status: "ACTIVE",
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
      },
      orderBy: [{ deadlineAt: "asc" }, { updatedAt: "desc" }],
      take: 30,
      select: {
        id: true,
        messageMd: true,
        status: true,
        deadlineAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        process: { select: { subjectType: true, subjectId: true } },
      },
    }),
    prisma.adviceRequest.findMany({
      where: {
        workspaceId: params.workspaceId,
        audienceType: "WORKSPACE",
        status: "COMPLETED",
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { completedAt: windowRange },
          { updatedAt: windowRange },
        ],
      },
      orderBy: [{ completedAt: "desc" }, { updatedAt: "desc" }],
      take: 10,
      select: {
        id: true,
        messageMd: true,
        status: true,
        deadlineAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        process: { select: { subjectType: true, subjectId: true } },
      },
    }),
  ]);

  const workspaceAdviceRequests = [
    ...activeWorkspaceAdviceRequests,
    ...completedWorkspaceAdviceRequests,
  ];
  const workspaceAdviceSubjectPreviews = await loadAdviceSubjectPreviews(
    params.workspaceId,
    workspaceAdviceRequests as unknown as PendingAdviceDigestRequest[],
    { until: params.until },
  );
  const workspaceAdviceRequestsWithSubjects = workspaceAdviceRequests.map((request) => {
    const subjectType = validAdviceSubjectType(request.process.subjectType);
    const subjectPreview = subjectType
      ? workspaceAdviceSubjectPreviews.get(`${subjectType}:${request.process.subjectId}`) ?? null
      : null;
    return {
      ...request,
      subjectPreview,
      subjectUrl: subjectPreview ? adviceSubjectUrl(params.workspaceId, subjectPreview) : null,
    };
  });

  return {
    meetings: meetings as OperatingDigestInputs["meetings"],
    proposals: proposals as OperatingDigestInputs["proposals"],
    resolvedTensions: resolvedTensions as OperatingDigestInputs["resolvedTensions"],
    openActions: openActions as OperatingDigestInputs["openActions"],
    goals: goals as OperatingDigestInputs["goals"],
    roleVersions: roleVersions as OperatingDigestInputs["roleVersions"],
    roleHolderHistory: roleHolderHistory as OperatingDigestInputs["roleHolderHistory"],
    newMembers: newMembers as OperatingDigestInputs["newMembers"],
    brainArticles: brainArticles as OperatingDigestInputs["brainArticles"],
    documents: documents as OperatingDigestInputs["documents"],
    workspaceAdviceRequests: workspaceAdviceRequestsWithSubjects as OperatingDigestInputs["workspaceAdviceRequests"],
  };
}

function buildDigestSourceCounts(params: {
  operatingInputs: OperatingDigestInputs;
  sessions: unknown[];
  slackMessages: unknown[];
  buildArtifacts: unknown[];
  pendingAdviceByMemberId: Map<string, string[]>;
}): DigestSourceCounts {
  const adviceRequestIds = new Set<string>();
  for (const items of params.pendingAdviceByMemberId.values()) {
    for (const item of items) adviceRequestIds.add(item);
  }
  for (const request of params.operatingInputs.workspaceAdviceRequests) {
    adviceRequestIds.add(request.id);
  }
  return {
    meetings: params.operatingInputs.meetings.length,
    proposals: params.operatingInputs.proposals.length,
    resolvedTensions: params.operatingInputs.resolvedTensions.length,
    openActions: params.operatingInputs.openActions.length,
    goals: params.operatingInputs.goals.length,
    roleChanges: params.operatingInputs.roleVersions.length,
    roleHolderChanges: params.operatingInputs.roleHolderHistory.length,
    newMembers: params.operatingInputs.newMembers.length,
    brainArticles: params.operatingInputs.brainArticles.length,
    documents: params.operatingInputs.documents.length,
    adviceRequests: adviceRequestIds.size,
    conversations: params.sessions.length,
    slackMessages: params.slackMessages.length,
    buildArtifacts: params.buildArtifacts.length,
  };
}

function formatWorkspaceAdviceRequestDigestInput(requests: OperatingDigestInputs["workspaceAdviceRequests"]) {
  return requests.map((request) => {
    const subjectType = validAdviceSubjectType(request.process.subjectType);
    const subjectLabel = subjectType ? adviceSubjectLabel(subjectType) : "subject";
    const subjectTitle = request.subjectPreview?.title
      ? `${subjectLabel} - ${request.subjectPreview.title}`
      : `${subjectLabel} title unavailable`;
    const statusLabel = request.status === "COMPLETED" ? "Advice request completed" : "Advice request awaiting input";
    const completed = formatAdviceDigestDate(request.completedAt);
    const deadline = formatAdviceDigestDate(request.deadlineAt);
    return [
      `${statusLabel}: ${subjectTitle}`,
      `Request: ${truncateDigestText(request.messageMd)}`,
      request.status === "COMPLETED" && completed ? `Completed: ${completed}` : null,
      request.status === "ACTIVE" && deadline ? `Deadline: ${deadline}` : null,
      request.subjectUrl ? `Open: ${request.subjectUrl}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function buildOperatingDigestInput(inputs: OperatingDigestInputs, counts: DigestSourceCounts) {
  return [
    `Operating source counts: ${sourceCountsLine(counts)}`,
    inputs.meetings.length > 0 ? `Meeting summaries and decisions:\n${formatMeetingDigestInput(inputs.meetings)}` : null,
    inputs.proposals.length > 0 ? `Decisions and proposals:\n${formatProposalDigestInput(inputs.proposals)}` : null,
    inputs.resolvedTensions.length > 0 ? `Resolved tensions:\n${formatResolvedTensionDigestInput(inputs.resolvedTensions)}` : null,
    inputs.openActions.length > 0 ? `Open actions:\n${formatOpenActionDigestInput(inputs.openActions)}` : null,
    inputs.workspaceAdviceRequests.length > 0 ? `Workspace advice requests and closures:\n${formatWorkspaceAdviceRequestDigestInput(inputs.workspaceAdviceRequests)}` : null,
    inputs.goals.length > 0 ? `Goals and quarterly progress:\n${formatGoalDigestInput(inputs.goals)}` : null,
    inputs.roleVersions.length + inputs.roleHolderHistory.length + inputs.newMembers.length > 0
      ? `Roles and people changes:\n${formatRolesAndPeopleDigestInput(inputs)}`
      : null,
    inputs.brainArticles.length + inputs.documents.length > 0
      ? `Brain and document updates:\n${formatBrainAndDocumentDigestInput(inputs)}`
      : null,
  ].filter(Boolean).join("\n\n---\n\n");
}

function formatAssignedActionDigestItem(params: {
  workspaceId: string;
  action: OperatingDigestInputs["openActions"][number];
}) {
  const due = formatDigestDate(params.action.dueAt);
  return [
    `Assigned action: ${params.action.title}`,
    compactDigestLine(params.action.bodyMd, 300) ? `Detail: ${compactDigestLine(params.action.bodyMd, 300)}` : null,
    due ? `Due: ${due}` : null,
    params.action.priority > 0 ? `Priority: ${params.action.priority}` : null,
    `Open: ${workspaceUrl(params.workspaceId)}/actions/${params.action.id}`,
  ].filter(Boolean).join("\n");
}

function buildPersonalActionItemsByMember(params: {
  workspaceId: string;
  pendingAdviceByMemberId: Map<string, string[]>;
  openActions: OperatingDigestInputs["openActions"];
}) {
  const itemsByMemberId = new Map<string, string[]>(
    [...params.pendingAdviceByMemberId.entries()].map(([memberId, items]) => [memberId, [...items]]),
  );
  for (const action of params.openActions) {
    if (!action.assigneeMemberId) continue;
    const existing = itemsByMemberId.get(action.assigneeMemberId) ?? [];
    existing.push(formatAssignedActionDigestItem({
      workspaceId: params.workspaceId,
      action,
    }));
    itemsByMemberId.set(action.assigneeMemberId, existing);
  }
  return itemsByMemberId;
}

export async function runDailyDigest(params: {
  workspaceId: string;
  workflowJobId?: string;
  agentRunId?: string;
  dateISO: string;
  dateKey?: string;
  cadence?: NewspaperCadence;
  model?: string;
}) {
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "daily-digest-agent",
  };

  const cadence = normalizeNewspaperCadence(params.cadence);
  if (!isDeliveryCadence(cadence)) {
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      cadence,
      reason: "cadence_off",
    });
    return {
      success: true,
      message: "Newspaper cadence is off.",
      cadence,
      processedSessions: 0,
      processedSlackMessages: 0,
      updatedProfiles: 0,
      sentEmails: 0,
      failedEmails: 0,
      skippedEmails: 0,
    };
  }

  const workspaceCadence = await getWorkspaceNewspaperCadence(params.workspaceId);
  const activeMembers = await prisma.member.findMany({
    where: { workspaceId: params.workspaceId, isActive: true },
    include: {
      user: { select: { email: true, displayName: true, id: true } },
      roleAssignments: {
        select: {
          role: {
            select: {
              circleId: true,
              archivedAt: true,
              circle: {
                select: {
                  workspaceId: true,
                  archivedAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const recipientMembers = activeMembers.filter((member) => (
    isHumanNewspaperRecipientIdentity(member)
    &&
    (member.newspaperCadence ?? workspaceCadence) === cadence
  ));

  if (recipientMembers.length === 0) {
    logger.info("newspaper_delivery_skipped", {
      workspaceId: params.workspaceId,
      cadence,
      reason: "no_matching_recipients",
      generationContinues: true,
    });
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { name: true },
  });
  const workspaceName = workspace?.name?.trim() || "Corgtex";

  const lookbackDays = LOOKBACK_DAYS_BY_CADENCE[cadence];
  const briefingPeriod = workspaceBriefingPeriodFromCadence(cadence);
  const generationDate = new Date(params.dateISO);
  const since = new Date(generationDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const windowRange = { gte: since, lte: generationDate };
  const briefingSince = workspaceBriefingContextSince(briefingPeriod, generationDate);
  const model = params.model ?? resolveModel(
    AGENT_REGISTRY["daily-digest"].defaultModelTier,
    await getAgentModelOverride(params.workspaceId, "daily-digest"),
  );

  // 1. Batch ingest all raw conversations as tier-3 sources
  await batchIngestDailyConversations({
    workspaceId: params.workspaceId,
    since,
  });

  // 2. Load all conversations from past 24h to extract insights and build the digest
  const sessions = await prisma.conversationSession.findMany({
    where: {
      workspaceId: params.workspaceId,
      turns: { some: { createdAt: windowRange } }
    },
    include: {
      turns: {
        where: { createdAt: windowRange },
        orderBy: { sequenceNumber: "asc" }
      },
      user: {
        select: { id: true, email: true, displayName: true }
      }
    }
  });
  const slackMessages = await listSlackMessagesForDigest(params.workspaceId, since, generationDate);
  const buildArtifacts = await prisma.buildArtifact.findMany({
    where: {
      workspaceId: params.workspaceId,
      updatedAt: { lte: generationDate },
      OR: [
        { updatedAt: windowRange },
        { mergedAt: windowRange },
        { closedAt: windowRange },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: {
      repositoryOwner: true,
      repositoryName: true,
      pullRequestNumber: true,
      pullRequestUrl: true,
      branchName: true,
      title: true,
      summaryMd: true,
      status: true,
      mergedAt: true,
      closedAt: true,
      updatedAt: true,
      assets: {
        select: {
          kind: true,
          label: true,
          captionMd: true,
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take: 5,
      },
    },
  });
  const pendingAdviceByMemberId = await loadPendingAdviceRequestsByMember({
    workspaceId: params.workspaceId,
    recipientMembers,
  });
  const operatingInputs = await loadOperatingDigestInputs({
    workspaceId: params.workspaceId,
    since,
    until: generationDate,
  });
  const briefingCandidates = await collectWorkspaceBriefingCandidates({
    workspaceId: params.workspaceId,
    since: briefingSince,
    now: generationDate,
    until: generationDate,
  });
  const personalItemsByMemberId = buildPersonalActionItemsByMember({
    workspaceId: params.workspaceId,
    pendingAdviceByMemberId,
    openActions: operatingInputs.openActions,
  });
  const sourceCounts = buildDigestSourceCounts({
    operatingInputs,
    sessions,
    slackMessages,
    buildArtifacts,
    pendingAdviceByMemberId,
  });
  const digestDateKey = params.dateKey ?? params.dateISO.split("T")[0];
  const digestTitle = `${cadenceLabel(cadence)} Newspaper - ${digestDateKey}`;
  const digestSlug = `${cadence.toLowerCase()}-newspaper-${digestDateKey}`;
  const runKey = params.workflowJobId ?? `${params.workspaceId}:${cadence.toLowerCase()}-newspaper:${digestDateKey}`;

  const hasSourceInputs = hasDigestSourceInputs(sourceCounts);
  if (!hasSourceInputs) {
    logger.info("workspace_briefing_quiet_day", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      cadence,
      sourceCounts,
    });
  }

  // 3. Extract member insights and update PERSON profiles
  const members = new Map<string, { user: { id: string; email: string; displayName: string | null }; transcripts: string[] }>();
  for (const session of sessions) {
    if (!members.has(session.userId)) {
      members.set(session.userId, { user: session.user!, transcripts: [] });
    }
    const transcript = session.turns.map(t => `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`).join("\n");
    members.get(session.userId)!.transcripts.push(transcript);
  }

  // Pre-load existing PERSON articles for all conversing members in one query
  // instead of a per-member findUnique inside the loop below. Each slug is read
  // once here and written at most once in its own iteration, so the pre-loop
  // snapshot is equivalent to the previous per-iteration read.
  const memberPersonSlugs = [...members.keys()].map((userId) => `person-${userId}`);
  const existingPersonArticles = memberPersonSlugs.length
    ? await prisma.brainArticle.findMany({
        where: { workspaceId: params.workspaceId, slug: { in: memberPersonSlugs } },
      })
    : [];
  const existingPersonArticlesBySlug = new Map(existingPersonArticles.map((article) => [article.slug, article]));

  const memberUpdates = [];
  for (const [userId, data] of members.entries()) {
    const fullTranscript = data.transcripts.join("\n\n---\n\n").slice(0, 8000); // Take up to 8K chars

    const extraction = await defaultModelGateway.extract({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      instruction: `Analyze this user's conversations from the past 24 hours. Extract:
1. Sentiment and mood (e.g., frustrated, excited, neutral)
2. Communication preferences or styles
3. Key concerns, tensions, or blockers they mentioned
4. People dynamics they brought up`,
      schemaHint: `{
        sentiment: string,
        preferences: string[],
        tensions: string[],
        peopleSignals: string[]
      }`,
      input: fullTranscript
    });

    const insights = extraction.output as any;

    const source = await prisma.brainSource.create({
      data: {
        workspaceId: params.workspaceId,
        sourceType: "CONVERSATION_INSIGHT",
        tier: 3,
        content: JSON.stringify(insights, null, 2),
        title: `Daily Insights for ${data.user.displayName || data.user.email} - ${params.dateISO.split("T")[0]}`,
        channel: "daily-digest",
        metadata: { userId, date: params.dateISO },
      }
    });

    // Check if PERSON article exists for this user
    const slug = `person-${userId}`;
    const existingArticle = existingPersonArticlesBySlug.get(slug) ?? null;

    const profileMergeResult = await defaultModelGateway.chat({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      taskType: "AGENT",
      messages: [
        {
          role: "system",
          content: `You are maintaining a living user profile.
Here is the current profile:
${existingArticle?.bodyMd || "No profile yet."}

Here are new insights from today's conversations:
${JSON.stringify(insights)}

Produce an updated, complete profile in structured markdown format.
Rules:
- MERGE new information with existing data
- If preferences or mood have CHANGED, update them (don't append contradictions)
- Keep the "Recent Context" section current (remove outdated items)
- Maintain structured section headers exactly (e.g. Identity, Communication Preferences, Current Sentiment, Key Concerns & Tensions, Working Style, Relationship Dynamics, Recent Context)`
        }
      ]
    });

    const newBodyMd = profileMergeResult.content;

    if (existingArticle?.authority && existingArticle.authority !== "DRAFT") {
      logger.info("newspaper_profile_update_skipped", {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        articleId: existingArticle.id,
        slug,
        reason: "non_draft_article",
      });
    } else if (existingArticle) {
      await updateArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug,
        bodyMd: newBodyMd,
        sourceIds: [...(existingArticle.sourceIds || []), source.id],
        changeSummary: "Daily insight update",
        agentRunId: params.agentRunId ?? null,
      });
    } else {
      await createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug,
        title: data.user.displayName || data.user.email,
        type: "PERSON" as BrainArticleType,
        authority: "DRAFT",
        bodyMd: `# ${data.user.displayName || data.user.email}\n\n` + newBodyMd,
        sourceIds: [source.id],
      });
    }
    memberUpdates.push({ userId, insights });
  }

  // 4. Generate org-wide Digest
  const conversationTranscripts = sessions.map(s => s.turns.map(t => `${s.user.displayName}: ${t.userMessage}\nAssistant: ${t.assistantMessage}`).join("\n")).join("\n\n---\n\n");
  const slackTranscript = slackMessages.map((message) => {
    const speaker = message.externalUserId ?? "Slack";
    const channel = message.externalChannelId;
    const text = message.text ?? "";
    return `[Slack #${channel}] ${speaker}: ${text}`;
  }).join("\n");
  const operatingDigestInput = buildOperatingDigestInput(operatingInputs, sourceCounts);
  const allTranscripts = [
    operatingDigestInput ? `Corgtex operating data:\n${operatingDigestInput}` : "",
    conversationTranscripts ? `Corgtex conversations:\n${conversationTranscripts}` : "",
    slackTranscript ? `Slack public-channel messages:\n${slackTranscript}` : "",
    buildArtifacts.length > 0 ? `Built / PR activity for accomplishments and shipped work:\n${formatBuildArtifactDigestInput(buildArtifacts)}` : "",
  ].filter(Boolean).join("\n\n---\n\n").slice(0, 22000);

  const digest = hasSourceInputs
    ? normalizeNewspaperDigestPayload((await defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId,
        agentRunId: params.agentRunId,
        instruction: `Generate a structured ${cadenceLabel(cadence)} Newspaper evidence summary for the workspace based on the last ${lookbackDays} day(s) of Corgtex operating data. Prioritize what helps the reader understand the workspace: what changed, what decisions or blockers matter, what needs attention, and what evidence supports it. Return one topic per array item so the formatter can render separate paragraphs or list rows. Return complete, readable item sentences with no ellipses, truncated titles, raw URLs, or pasted source links. Use the arrays only as internal evidence buckets; do not write category headings inside the item text. Return concise, non-empty arrays only when the source material supports them.`,
        schemaHint: `{
          intro: string | null,
          meetingBriefs: string[],
          decisionsAndProposals: string[],
          resolvedTensions: string[],
          openActions: string[],
          goalsProgress: string[],
          rolesAndPeople: string[],
          adviceRequests: string[],
          builtWork: string[],
          conversationHighlights: string[],
          teamPulse: string[],
          emergingTensions: string[],
          otherUpdates: string[]
        }`,
        input: allTranscripts,
      })).output)
    : normalizeNewspaperDigestPayload({});

  const workspaceBriefing = digest.sections.length > 0
    ? buildWorkspaceBriefingFromDigest({
        workspaceId: params.workspaceId,
        period: briefingPeriod,
        dateKey: digestDateKey,
        title: digestTitle,
        digest,
        candidates: briefingCandidates,
        generatedAt: generationDate,
        editorialMode: cadence === "WEEKLY" ? "weekly_email" : "daily_homepage",
      })
    : buildWorkspaceBriefingFromCandidates({
        workspaceId: params.workspaceId,
        period: briefingPeriod,
        dateKey: digestDateKey,
        title: digestTitle,
        candidates: briefingCandidates,
        generatedAt: generationDate,
        editorialMode: cadence === "WEEKLY" ? "weekly_email" : "daily_homepage",
      });
  const briefingBodyMd = renderWorkspaceBriefingMarkdown(workspaceBriefing);
  const storedBriefing = await upsertWorkspaceBriefing({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    period: briefingPeriod,
    dateKey: digestDateKey,
    runKey,
    title: digestTitle,
    modelUsed: model,
    briefing: workspaceBriefing,
    bodyMd: briefingBodyMd,
    sourceCounts,
  });
  const editionDigest = workspaceBriefingToNewspaperDigest({
    briefingJson: storedBriefing.briefingJson,
  });
  const shouldPersistNewspaperEdition = recipientMembers.length > 0;

  if (editionDigest.sections.length > 0 && shouldPersistNewspaperEdition) {
    const digestBodyMd = renderNewspaperDigestMarkdown({ title: digestTitle, digest: editionDigest });
    const existingDigestArticle = await prisma.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: digestSlug,
        },
      },
    });

    if (existingDigestArticle?.authority && existingDigestArticle.authority !== "DRAFT") {
      logger.info("newspaper_digest_article_write_skipped", {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        articleId: existingDigestArticle.id,
        slug: digestSlug,
        reason: "non_draft_article",
      });
    } else if (existingDigestArticle) {
      await updateArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug: digestSlug,
        title: digestTitle,
        bodyMd: digestBodyMd,
        changeSummary: `Regenerated ${cadence.toLowerCase()} newspaper for ${digestDateKey}`,
        agentRunId: params.agentRunId ?? null,
      });
    } else {
      await createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug: digestSlug,
        title: digestTitle,
        type: "DIGEST" as BrainArticleType,
        authority: "DRAFT",
        bodyMd: digestBodyMd,
      });
    }

    await upsertNewspaperEdition({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      cadence,
      dateKey: digestDateKey,
      runKey,
      title: digestTitle,
      slug: digestSlug,
      digestJson: editionDigest,
      bodyMd: digestBodyMd,
      sourceCounts,
    });

    // 5. Rebuild backlinks
    await rebuildBacklinks(agentActor, { workspaceId: params.workspaceId });
  } else {
    logger.info("newspaper_digest_article_write_skipped", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      slug: digestSlug,
      reason: editionDigest.sections.length === 0 ? "empty_workspace_briefing_digest" : "no_matching_recipients",
    });
  }

  // 6. Send personalized digest emails
  let sentEmails = 0;
  let failedEmails = 0;
  let skippedEmails = 0;

  // Pre-load recipient PERSON profiles in one query (after the profile-rebuild
  // writes above, so freshly-updated profiles are reflected) instead of a
  // per-recipient findUnique inside the loop below.
  const recipientPersonSlugs = recipientMembers.map((member) => `person-${member.user.id}`);
  const recipientPersonArticles = recipientPersonSlugs.length
    ? await prisma.brainArticle.findMany({
        where: { workspaceId: params.workspaceId, slug: { in: recipientPersonSlugs } },
        select: { slug: true, bodyMd: true },
      })
    : [];
  const recipientPersonArticleBySlug = new Map(recipientPersonArticles.map((article) => [article.slug, article]));
  const emailDigest = editionDigest;

  for (const member of recipientMembers) {
    const personArticle = recipientPersonArticleBySlug.get(`person-${member.user.id}`) ?? null;
    const recipientDigest = withNewspaperAdviceRequests(emailDigest, personalItemsByMemberId.get(member.id) ?? []);
    const subject = `${storedBriefing.title} - Your Personal Briefing`;

    if (recipientDigest.sections.length === 0) {
      const reason = "No digest sections generated for this recipient.";
      skippedEmails++;
      await recordNewspaperDelivery({
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        memberId: member.id,
        kind: "MEMBER_NEWSPAPER",
        cadence,
        runKey,
        recipientEmail: member.user.email,
        subject,
        status: "SKIPPED",
        error: reason,
      });
      continue;
    }

    const personalizationExtraction = await defaultModelGateway.extract({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      instruction: `Personalize this workspace newspaper for a specific member. Fold any member-specific advice requests or assigned work into one short prose memberNote. Do not create section headings, category labels, bullet lists, or HTML.`,
      schemaHint: `{
        greeting: string | null,
        intro: string | null,
        memberNote: string | null,
        emphasizedSectionIds: string[]
      }`,
      input: JSON.stringify({
        recipient: member.user.displayName || member.user.email,
        profile: personArticle?.bodyMd || "No profile available.",
        digest: recipientDigest,
      }),
    });
    const personalization = normalizeNewspaperPersonalizationPayload(personalizationExtraction.output);

    const html = await instrumentNewspaperHtmlLinks({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      runKey,
      html: renderWorkspaceBriefingEmailHtml({
        briefing: {
          title: storedBriefing.title,
          briefingJson: storedBriefing.briefingJson,
        },
        workspaceName,
        recipientName: member.user.displayName || member.user.email,
        workspaceUrl: workspaceUrl(params.workspaceId),
        digest: recipientDigest,
        personalization,
      }),
    });

    try {
      const emailResult = await sendEmail({
        to: member.user.email,
        subject,
        html,
        tracking: {
          emailType: "newspaper.member",
          userId: member.user.id,
          workspaceId: params.workspaceId,
          metadata: {
            workspaceId: params.workspaceId,
            workflowJobId: params.workflowJobId ?? null,
            runKey,
            cadence,
            kind: "MEMBER_NEWSPAPER",
          },
        },
      });
      if (emailResult.status === "SENT") {
        sentEmails++;
        await recordNewspaperDelivery({
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId ?? null,
          memberId: member.id,
          kind: "MEMBER_NEWSPAPER",
          cadence,
          runKey,
          recipientEmail: member.user.email,
          subject,
          status: "SENT",
          providerMessageId: emailResult.providerMessageId,
        });
      } else {
        skippedEmails++;
        await recordNewspaperDelivery({
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId ?? null,
          memberId: member.id,
          kind: "MEMBER_NEWSPAPER",
          cadence,
          runKey,
          recipientEmail: member.user.email,
          subject,
          status: "SKIPPED",
          error: emailResult.reason,
        });
      }
    } catch (error) {
      failedEmails++;
      const message = error instanceof Error ? error.message : "Unknown email error";
      await recordNewspaperDelivery({
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        memberId: member.id,
        kind: "MEMBER_NEWSPAPER",
        cadence,
        runKey,
        recipientEmail: member.user.email,
        subject,
        status: "FAILED",
        error: message,
      });
      logger.error("newspaper_delivery_failed", {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        cadence,
        memberId: member.id,
        error: message,
      });
    }
  }

  logger.info("newspaper_delivery_completed", {
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    cadence,
    recipients: recipientMembers.length,
    sentEmails,
    failedEmails,
    skippedEmails,
  });

  return {
    success: true,
    digestSlug,
    briefingId: storedBriefing.id,
    cadence,
    processedSessions: sessions.length,
    processedSlackMessages: slackMessages.length,
    updatedProfiles: memberUpdates.length,
    sentEmails,
    failedEmails,
    skippedEmails,
  };
}

export async function sendDemoWelcomeNewspaper(params: {
  workspaceId: string;
  demoLeadId: string;
  workflowJobId?: string;
}) {
  const lead = await prisma.demoLead.findFirst({
    where: {
      id: params.demoLeadId,
      workspaceId: params.workspaceId,
    },
    include: {
      workspace: { select: { name: true } },
    },
  });

  if (!lead) {
    return { success: true, skipped: true, message: "Demo lead not found." };
  }

  if (lead.welcomeEmailSentAt) {
    await recordDemoWelcomeCrmActivity({
      workspaceId: params.workspaceId,
      demoLeadId: lead.id,
      expectedContactId: lead.convertedContactId,
    });
    return { success: true, skipped: true, message: "Welcome newspaper already sent." };
  }

  const subject = "Welcome to Corgtex - your first newspaper";
  const runKey = params.workflowJobId ?? `demo-welcome:${lead.id}`;
  const html = await instrumentNewspaperHtmlLinks({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    runKey,
    html: buildDemoWelcomeNewspaperHtml({ workspaceName: lead.workspace.name }),
  });
  let deliveryStatus: "SENT" | "SKIPPED" = "SENT";
  let providerMessageId: string | null = null;
  let deliveryError: string | null = null;

  try {
    const emailResult = await sendEmail({
      to: lead.email,
      subject,
      html,
      tracking: {
        emailType: "newspaper.demo_welcome",
        workspaceId: params.workspaceId,
        metadata: {
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId ?? null,
          runKey,
          kind: "DEMO_WELCOME",
          demoLeadId: lead.id,
        },
      },
    });
    if (emailResult.status === "SENT") {
      providerMessageId = emailResult.providerMessageId;
    } else {
      deliveryStatus = "SKIPPED";
      deliveryError = emailResult.reason;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email error";
    await recordNewspaperDelivery({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      demoLeadId: lead.id,
      kind: "DEMO_WELCOME",
      runKey,
      recipientEmail: lead.email,
      subject,
      status: "FAILED",
      error: message,
    });
    logger.error("newspaper_delivery_failed", {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      kind: "DEMO_WELCOME",
      demoLeadId: lead.id,
      error: message,
    });
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    await tx.demoLead.update({
      where: { id: lead.id },
      data: { welcomeEmailSentAt: new Date() },
    });

    const now = new Date();
    await tx.newspaperDelivery.create({
      data: {
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId ?? null,
        demoLeadId: lead.id,
        kind: "DEMO_WELCOME",
        runKey,
        recipientEmail: lead.email,
        subject,
        status: deliveryStatus,
        providerMessageId,
        error: deliveryError,
        sentAt: deliveryStatus === "SENT" ? now : null,
        skippedAt: deliveryStatus === "SKIPPED" ? now : null,
      },
    });
  });
  await recordDemoWelcomeCrmActivity({
    workspaceId: params.workspaceId,
    demoLeadId: lead.id,
    expectedContactId: lead.convertedContactId,
  });

  logger.info("newspaper_delivery_completed", {
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    kind: "DEMO_WELCOME",
    demoLeadId: lead.id,
    status: deliveryStatus,
  });

  return { success: true, skipped: false };
}
