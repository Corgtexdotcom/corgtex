import type { BrainArticle, Meeting, Prisma } from "@prisma/client";
import {
  getUnreadNotificationSummary,
  DigestReadRelease,
  filterWorkspaceBriefingSources,
  normalizeNewspaperEditionDigest,
  normalizeWorkspaceBriefingPayload,
  personalizeWorkspaceBriefing,
  privacyFilter,
  rankPersonalNewspaperItems,
  requireWorkspaceMembership,
  scoreMemberBriefingItem,
} from "@corgtex/domain";
import type { MemberBriefingContext, PersonalNewspaperItem } from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
import { getReadableKnowledgeChunkSummary } from "@corgtex/knowledge";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { markdownToPlainText } from "@/lib/markdown";
import {
  capDashboardUnreadNotificationCount,
  isDashboardUnreadNotificationCountCapped,
} from "@/lib/dashboard-briefing";
import { notificationUnreadCountLabel } from "@/lib/notification-count";
import { findLatestReadableArtifact, scanReadableArtifactPages } from "@/lib/readable-artifact-pages";
import { getDashboardWorkAttentionCountsFromMetrics } from "@/lib/dashboard-attention";

export const dynamic = "force-dynamic";

function isExternalHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://");
}

function utcDueDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function compactNarrativeText(markdown: string | null | undefined, maxLength = 520) {
  if (!markdown?.trim()) return null;
  const text = markdownToPlainText(markdown, 2000)
    .replace(/\s*(?:\.{3}|…)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;

  const slice = text.slice(0, maxLength).trimEnd();
  const sentenceBoundary = lastSentenceBoundary(slice);
  if (sentenceBoundary > Math.floor(maxLength * 0.55)) {
    return slice.slice(0, sentenceBoundary + 1).trim();
  }

  const wordBoundary = slice.lastIndexOf(" ");
  const trimmed = wordBoundary > Math.floor(maxLength * 0.55)
    ? slice.slice(0, wordBoundary).trim()
    : slice;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lastSentenceBoundary(value: string) {
  let boundary = -1;
  const sentenceBoundaryPattern = /[.!?](?=(?:["')\]]?\s|["')\]]?$|$))/g;
  for (const match of value.matchAll(sentenceBoundaryPattern)) {
    boundary = match.index ?? boundary;
  }
  return boundary;
}

function narrativeLine(title: string | null | undefined, summary: string | null | undefined) {
  const normalizedTitle = title?.replace(/\s+/g, " ").trim() || "Workspace update";
  return summary && summary !== normalizedTitle
    ? `**${normalizedTitle}**: ${summary}`
    : `**${normalizedTitle}**`;
}

function latestActivityTimeBefore(until: Date, ...values: Array<Date | string | null | undefined>) {
  const cutoff = until.getTime();
  const times = values
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter((time) => Number.isFinite(time) && time <= cutoff);
  return times.length > 0 ? Math.max(...times) : 0;
}

type DisplayedEditionPeriod = "DAILY" | "WEEKLY" | null;

function NewspaperSection({
  title,
  markdown,
  className,
}: {
  title: string;
  markdown: string | null | undefined;
  className?: string;
}) {
  if (!markdown?.trim()) return null;
  return (
    <section className="nr-newspaper-section">
      <h3>{title}</h3>
      <MarkdownRenderer markdown={markdown} variant="document" className={className} allowImages={false} />
    </section>
  );
}

function legacyEditionNarrative(
  editionDigest: ReturnType<typeof normalizeNewspaperEditionDigest> | null,
  labels: { intro: string; closing: string },
) {
  if (!editionDigest) return null;
  const items = editionDigest.sections.flatMap((section) => section.items).filter(Boolean);
  return {
    introMd: editionDigest.intro ?? labels.intro,
    leadMd: items[0] ?? null,
    bodyMd: items.slice(1, 5).join("\n\n") || null,
    closingMd: labels.closing,
  };
}

function liveWorkspaceNarrative(params: {
  workspaceId: string;
  memberContext: MemberBriefingContext | null;
  articles: Array<{
    id: string;
    slug: string;
    title: string;
    bodyMd?: string | null;
    type?: string | null;
    isPrivate?: boolean | null;
    updatedAt?: Date | string | null;
    publishedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  meetings: Array<{
    id: string;
    title?: string | null;
    summaryMd?: string | null;
    recordedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  labels: { intro: string; closing: string };
}) {
  const now = new Date();
  const entries = [
    ...params.meetings.map((meeting) => {
      const title = meeting.title || "Meeting recap";
      return {
        kind: "MEETING" as const,
        title,
        summaryMd: meeting.summaryMd ?? "",
        occurredAt: latestActivityTimeBefore(now, meeting.updatedAt, meeting.recordedAt, meeting.createdAt),
        line: narrativeLine(title, compactNarrativeText(meeting.summaryMd, 620)),
        sourceRef: {
          type: "MEETING" as const,
          id: meeting.id,
          label: title,
          href: `/workspaces/${params.workspaceId}/meetings/${meeting.id}`,
        },
      };
    }),
    ...params.articles
      .filter((article) => article.type !== "DIGEST" && article.type !== "PERSON" && !article.isPrivate)
      .map((article) => ({
        kind: "BRAIN_ARTICLE" as const,
        title: article.title,
        summaryMd: article.bodyMd ?? "",
        occurredAt: latestActivityTimeBefore(now, article.updatedAt, article.publishedAt, article.createdAt),
        line: narrativeLine(article.title, compactNarrativeText(article.bodyMd, 560)),
        sourceRef: {
          type: "BRAIN_ARTICLE" as const,
          id: article.id,
          label: article.title,
          href: `/workspaces/${params.workspaceId}/brain/${article.slug}`,
        },
      })),
  ]
    .filter((entry) => entry.occurredAt > 0 && entry.line.trim())
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, 20);

  if (entries.length === 0) return null;
  const latestActivityAt = entries[0].occurredAt;
  if (params.memberContext) {
    entries.sort((left, right) => (
      scoreMemberBriefingItem({ ...right, sourceRefs: [right.sourceRef] }, params.memberContext!)
      - scoreMemberBriefingItem({ ...left, sourceRefs: [left.sourceRef] }, params.memberContext!)
      || right.occurredAt - left.occurredAt
    ));
  }
  const selected = entries.slice(0, 5);
  return {
    introMd: params.labels.intro,
    leadMd: selected[0]?.line ?? null,
    bodyMd: selected.slice(1).map((entry) => entry.line).join("\n\n") || null,
    closingMd: params.labels.closing,
    sourceRefs: selected.map((entry) => entry.sourceRef),
    latestActivityAt,
  };
}

export default async function WorkspaceDashboard({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("dashboard");
  const format = await getFormatter();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const release = new DigestReadRelease(actor, workspaceId);
  const currentMember = actor.kind === "user" && actor.user.globalRole !== "OPERATOR"
    ? membership
    : actor.kind === "user"
      ? await prisma.member.findFirst({
        where: {
          workspaceId,
          userId: actor.user.id,
          isActive: true,
        },
        select: {
          id: true,
          workspaceId: true,
          userId: true,
          role: true,
          isActive: true,
        },
      })
      : null;

  const workItemVisibilityWhere = privacyFilter(actor, membership ?? null);
  const visibleOpenActionWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    ],
  } satisfies Prisma.ActionWhereInput;
  const visibleOpenProposalWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "OPEN",
      },
    ],
  } satisfies Prisma.ProposalWhereInput;
  const visibleOpenTensionWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "OPEN",
      },
    ],
  } satisfies Prisma.TensionWhereInput;
  const memberCircleAssignments = currentMember?.id
    ? await prisma.roleAssignment.findMany({
      where: {
        memberId: currentMember.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        role: {
          archivedAt: null,
          circle: { workspaceId, archivedAt: null },
        },
      },
      select: { role: { select: { circleId: true, name: true, circle: { select: { name: true } } } } },
    })
    : [];
  const memberCircleIds = memberCircleAssignments.map((assignment) => assignment.role.circleId);
  const pageArgs = (cursor: string | undefined, take: number) => ({
    orderBy: { id: "asc" as const }, take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const adviceDeadlinesByKind = {
    ACTION: new Map<string, Date | null>(),
    PROPOSAL: new Map<string, Date | null>(),
    TENSION: new Map<string, Date | null>(),
  };
  let adviceComplete = true;
  if (actor.kind === "user" && currentMember?.id) {
    const adviceWindow = await scanReadableArtifactPages({ actor, workspaceId, release, kind: "AdviceRequest",
      loadPage: (cursor, take) => prisma.adviceRequest.findMany({
        ...pageArgs(cursor, take),
        where: { workspaceId, status: "ACTIVE", requestedByUserId: { not: actor.user.id },
          OR: [
            { audienceType: "MEMBERS", recipients: { some: { memberId: currentMember.id } } },
            { audienceType: "WORKSPACE" },
            ...(memberCircleIds.length ? [{ audienceType: "CIRCLE" as const, targetCircleId: { in: memberCircleIds } }] : []),
          ],
        },
        include: { process: { select: { subjectType: true, subjectId: true } } },
      }),
      visit: (request) => {
        const kind = request.process.subjectType;
        if (kind !== "ACTION" && kind !== "PROPOSAL" && kind !== "TENSION") return;
        const deadlines = adviceDeadlinesByKind[kind];
        const previous = deadlines.get(request.process.subjectId);
        if (previous === undefined || (request.deadlineAt && (!previous || request.deadlineAt < previous))) {
          deadlines.set(request.process.subjectId, request.deadlineAt);
        }
      },
    });
    adviceComplete = adviceWindow.complete;
  }
  const latestPageArgs = (cursor: { id: string; generatedAt: Date } | undefined, take: number) => ({
    orderBy: [{ generatedAt: "desc" as const }, { id: "desc" as const }], take,
    ...(cursor ? { OR: [{ generatedAt: { lt: cursor.generatedAt } }, { generatedAt: cursor.generatedAt, id: { lt: cursor.id } }] } : {}),
  });
  const [unreadNotificationsSummary, briefingWindow, editionWindow, workspaceData, membersCount] = await Promise.all([
    getUnreadNotificationSummary(actor, workspaceId),
    findLatestReadableArtifact({ actor, workspaceId, release, kind: "WorkspaceBriefing",
      loadPage: (cursor, take) => {
        const { OR, ...paging } = latestPageArgs(cursor, take);
        return prisma.workspaceBriefing.findMany({ ...paging,
          where: { workspaceId, status: "GENERATED", period: { in: ["DAILY", "WEEKLY"] }, ...(OR ? { OR } : {}) },
        });
      },
    }),
    findLatestReadableArtifact({ actor, workspaceId, release, kind: "NewspaperEdition",
      loadPage: (cursor, take) => {
        const { OR, ...paging } = latestPageArgs(cursor, take);
        return prisma.newspaperEdition.findMany({ ...paging, where: { workspaceId, ...(OR ? { OR } : {}) } });
      },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
    prisma.member.count({ where: { workspaceId, isActive: true } }),
  ]);
  const latestWorkspaceBriefing = briefingWindow.item;
  const latestNewspaperEdition = editionWindow.item;
  const articles: BrainArticle[] = [];
  const meetings: Meeting[] = [];
  let actionPersonalCount = 0, proposalPersonalCount = 0, tensionPersonalCount = 0;
  let personalItems: PersonalNewspaperItem[] = [];
  const personalSources: MemberBriefingContext["personalSources"] = [];
  const rankingTime = new Date();
  const retainPersonal = (item: PersonalNewspaperItem) => {
    personalSources.push({ type: item.kind === "ADVICE" ? "ADVICE_REQUEST" : item.kind, id: item.id, title: item.title });
    personalItems = rankPersonalNewspaperItems([...personalItems, item], rankingTime).slice(0, 8);
  };
  const [articleWindow, actionWindow, proposalWindow, tensionWindow, meetingWindow] = await Promise.all([
    scanReadableArtifactPages({ actor, workspaceId, release, kind: "BrainArticle",
      loadPage: (cursor, take) => prisma.brainArticle.findMany({ where: { workspaceId, archivedAt: null }, ...pageArgs(cursor, take) }),
      visit: (article) => {
        if (article.isPrivate || article.type === "DIGEST" || article.type === "PERSON") return;
        articles.push(article);
        articles.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
        articles.length = Math.min(articles.length, 50);
      },
    }),
    scanReadableArtifactPages({ actor, workspaceId, release, kind: "Action",
      loadPage: (cursor, take) => prisma.action.findMany({ where: visibleOpenActionWhere, ...pageArgs(cursor, take) }),
      visit: (action) => {
        if (!currentMember || (action.assigneeMemberId !== currentMember.id && !adviceDeadlinesByKind.ACTION.has(action.id))) return;
        actionPersonalCount++;
        const adviceDeadline = adviceDeadlinesByKind.ACTION.get(action.id) ?? null;
        const useAdviceDeadline = adviceDeadline && (!action.dueAt || utcDueDay(adviceDeadline) <= utcDueDay(action.dueAt));
        retainPersonal({ id: action.id, title: action.title, status: action.status, priority: action.priority, updatedAt: action.updatedAt,
          kind: "ACTION", reason: action.assigneeMemberId === currentMember.id ? "assigned" : "advice",
          dueAt: useAdviceDeadline ? adviceDeadline : action.dueAt, dueAtKind: useAdviceDeadline ? "DATETIME" : "DATE",
          href: `/workspaces/${workspaceId}/actions/${action.id}` });
      },
    }),
    scanReadableArtifactPages({ actor, workspaceId, release, kind: "Proposal",
      loadPage: (cursor, take) => prisma.proposal.findMany({ where: visibleOpenProposalWhere, ...pageArgs(cursor, take) }),
      visit: (proposal) => {
        if (!currentMember || (proposal.ownerMemberId !== currentMember.id && !adviceDeadlinesByKind.PROPOSAL.has(proposal.id))) return;
        proposalPersonalCount++;
        retainPersonal({ id: proposal.id, title: proposal.title, status: proposal.status, priority: proposal.priority, updatedAt: proposal.updatedAt,
          kind: "PROPOSAL", reason: proposal.ownerMemberId === currentMember.id ? "owner" : "advice",
          dueAt: adviceDeadlinesByKind.PROPOSAL.get(proposal.id) ?? null, dueAtKind: "DATETIME",
          href: `/workspaces/${workspaceId}/proposals/${proposal.id}` });
      },
    }),
    scanReadableArtifactPages({ actor, workspaceId, release, kind: "Tension",
      loadPage: (cursor, take) => prisma.tension.findMany({ where: visibleOpenTensionWhere, ...pageArgs(cursor, take) }),
      visit: (tension) => {
        if (!currentMember || (tension.assigneeMemberId !== currentMember.id && !adviceDeadlinesByKind.TENSION.has(tension.id))) return;
        tensionPersonalCount++;
        retainPersonal({ id: tension.id, title: tension.title, status: tension.status, priority: tension.priority, updatedAt: tension.updatedAt,
          kind: "TENSION", reason: tension.assigneeMemberId === currentMember.id ? "assigned" : "advice",
          dueAt: adviceDeadlinesByKind.TENSION.get(tension.id) ?? null, dueAtKind: "DATETIME",
          href: `/workspaces/${workspaceId}/tensions/${tension.id}` });
      },
    }),
    scanReadableArtifactPages({ actor, workspaceId, release, kind: "Meeting",
      loadPage: (cursor, take) => prisma.meeting.findMany({ where: { workspaceId, status: "COMPLETED", archivedAt: null }, ...pageArgs(cursor, take) }),
      visit: (meeting) => {
        meetings.push(meeting);
        meetings.sort((a, b) => latestActivityTimeBefore(rankingTime, b.updatedAt, b.recordedAt, b.createdAt)
          - latestActivityTimeBefore(rankingTime, a.updatedAt, a.recordedAt, a.createdAt) || a.id.localeCompare(b.id));
        meetings.length = Math.min(meetings.length, 20);
      },
    }),
  ]);
  const chunksSummary = await getReadableKnowledgeChunkSummary(actor, workspaceId, { release });
  const limitedSnapshot = !chunksSummary.complete || !adviceComplete || !briefingWindow.complete || !editionWindow.complete
    || [articleWindow, actionWindow, proposalWindow, tensionWindow, meetingWindow].some(window => !window.complete);
  const personalComplete = adviceComplete && actionWindow.complete && proposalWindow.complete && tensionWindow.complete;
  const branding = workspaceData
    ? workspaceBranding(workspaceData)
    : { primaryName: "Corgtex", secondaryLabel: "powered by Corgtex" };
  const workAttentionCounts = getDashboardWorkAttentionCountsFromMetrics({
    currentMemberId: currentMember?.id ?? null,
    actionPersonalCount,
    actionTotalCount: actionWindow.count,
    proposalPersonalCount,
    proposalTotalCount: proposalWindow.count,
    tensionPersonalCount,
    tensionTotalCount: tensionWindow.count,
  });
  const memberContext: MemberBriefingContext | null = currentMember ? {
    roleNames: memberCircleAssignments.map((assignment) => assignment.role.name),
    circleNames: memberCircleAssignments.map((assignment) => assignment.role.circle.name),
    personalSources,
  } : null;
  const latestEditionDigest = latestNewspaperEdition
    ? normalizeNewspaperEditionDigest(latestNewspaperEdition)
    : null;
  const storedBriefing = latestWorkspaceBriefing
    ? normalizeWorkspaceBriefingPayload(latestWorkspaceBriefing.briefingJson)
    : null;
  const briefingRefs = storedBriefing
    ? [...storedBriefing.items, ...(storedBriefing.candidateItems ?? [])].flatMap((item) => item.sourceRefs)
    : [];
  const idsFor = (type: string) => [...new Set(briefingRefs.filter((ref) => ref.type === type).map((ref) => ref.id))];
  const visibleBriefingSources = briefingRefs.length > 0
    ? await Promise.all([
      prisma.brainArticle.findMany({ where: { workspaceId, id: { in: idsFor("BRAIN_ARTICLE") }, archivedAt: null, isPrivate: false, type: { notIn: ["DIGEST", "PERSON"] } }, select: { id: true } })
        .then((items) => items.map((item) => `BRAIN_ARTICLE:${item.id}`)),
      prisma.document.findMany({ where: { workspaceId, id: { in: idsFor("DOCUMENT") }, archivedAt: null, accessDomain: "WORKSPACE" }, select: { id: true } })
        .then((items) => items.map((item) => `DOCUMENT:${item.id}`)),
      prisma.meeting.findMany({ where: { workspaceId, id: { in: idsFor("MEETING") }, archivedAt: null }, select: { id: true } })
        .then((items) => items.map((item) => `MEETING:${item.id}`)),
      prisma.action.findMany({ where: { workspaceId, id: { in: idsFor("ACTION") }, archivedAt: null, isPrivate: false }, select: { id: true } })
        .then((items) => items.map((item) => `ACTION:${item.id}`)),
      prisma.proposal.findMany({ where: { workspaceId, id: { in: idsFor("PROPOSAL") }, archivedAt: null, isPrivate: false }, select: { id: true } })
        .then((items) => items.map((item) => `PROPOSAL:${item.id}`)),
      prisma.tension.findMany({ where: { workspaceId, id: { in: idsFor("TENSION") }, archivedAt: null, isPrivate: false }, select: { id: true } })
        .then((items) => items.map((item) => `TENSION:${item.id}`)),
      prisma.goal.findMany({ where: { workspaceId, id: { in: idsFor("GOAL") }, archivedAt: null, isPrivate: false, status: { notIn: ["DRAFT", "ABANDONED"] } }, select: { id: true } })
        .then((items) => items.map((item) => `GOAL:${item.id}`)),
      prisma.recognition.findMany({ where: { workspaceId, id: { in: idsFor("RECOGNITION") }, visibility: "WORKSPACE" }, select: { id: true } })
        .then((items) => items.map((item) => `RECOGNITION:${item.id}`)),
      prisma.adviceRequest.findMany({ where: { workspaceId, id: { in: idsFor("ADVICE_REQUEST") }, audienceType: "WORKSPACE" } })
        .then(async (items) => {
          const captured = await release.capture("AdviceRequest", items);
          return captured.records.map((item) => `ADVICE_REQUEST:${item.id}`);
        }),
    ])
    : [];
  const workspaceBriefing = storedBriefing
    ? filterWorkspaceBriefingSources(storedBriefing, new Set(visibleBriefingSources.flat()))
    : null;
  const latestBriefing = workspaceBriefing && memberContext
    ? personalizeWorkspaceBriefing(workspaceBriefing, memberContext)
    : workspaceBriefing;
  const storedGeneratedAt = latestWorkspaceBriefing?.generatedAt ?? latestNewspaperEdition?.generatedAt ?? null;
  const legacyNarrative = latestBriefing ? null : legacyEditionNarrative(latestEditionDigest, {
    intro: t("newspaperLegacyIntro"),
    closing: t("newspaperLegacyClosing"),
  });
  const liveNarrativeCandidate = liveWorkspaceNarrative({
    workspaceId,
    memberContext,
    articles,
    meetings,
    labels: {
      intro: limitedSnapshot ? t("limitedSnapshot") : storedGeneratedAt ? t("newspaperLiveUpdatedIntro") : t("newspaperLiveIntro"),
      closing: t("newspaperLiveClosing"),
    },
  });
  const liveNarrativeIsNewer = !!liveNarrativeCandidate
    && (!storedGeneratedAt || liveNarrativeCandidate.latestActivityAt > storedGeneratedAt.getTime());
  const useLiveNarrative = !!liveNarrativeCandidate
    && ((!latestBriefing && !legacyNarrative) || liveNarrativeIsNewer);
  const displayedBriefing = useLiveNarrative ? null : latestBriefing;
  const fallbackNarrative = useLiveNarrative ? null : legacyNarrative;
  const liveNarrative = useLiveNarrative ? liveNarrativeCandidate : null;
  const generatedAt = useLiveNarrative ? null : storedGeneratedAt;
  const displayedEditionPeriod: DisplayedEditionPeriod = displayedBriefing?.period
    ?? (fallbackNarrative ? (latestNewspaperEdition?.cadence === "WEEKLY" ? "WEEKLY" : "DAILY") : null);
  const displayedEditionLabel = displayedEditionPeriod === "WEEKLY"
    ? t("weeklyEdition")
    : displayedEditionPeriod === "DAILY"
      ? t("dailyEdition")
      : t("workspaceEdition");
  const unreadNotificationsCount = unreadNotificationsSummary.count;
  const unreadNotificationsDisplayCount = capDashboardUnreadNotificationCount(unreadNotificationsCount);
  const isUnreadNotificationsCountCapped = !unreadNotificationsSummary.complete || isDashboardUnreadNotificationCountCapped(unreadNotificationsCount);
  const notificationLabel = unreadNotificationsCount > 0
    ? t(isUnreadNotificationsCountCapped ? "unreadNotificationsSummaryCapped" : "unreadNotificationsSummary", {
      count: unreadNotificationsDisplayCount,
    })
    : t("notifications");
  const now = new Date();
  const dateString = format.dateTime(now, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeString = format.dateTime(now, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const articleTitle = displayedBriefing?.title ?? (fallbackNarrative ? latestNewspaperEdition?.title : null) ?? t("latestWorkspaceBriefing");
  const hasArticle = !!displayedBriefing || !!fallbackNarrative || !!liveNarrative;
  const sourceRefs = displayedBriefing?.sourceRefs ?? liveNarrative?.sourceRefs ?? [];
  const attentionTiles = [
    {
      href: `/workspaces/${workspaceId}/actions?status=OPEN&status=IN_PROGRESS`,
      label: t("attentionActions"),
      counts: workAttentionCounts.actions,
      complete: actionWindow.complete,
    },
    {
      href: `/workspaces/${workspaceId}/proposals?status=OPEN`,
      label: t("attentionProposals"),
      counts: workAttentionCounts.proposals,
      complete: proposalWindow.complete,
    },
    {
      href: `/workspaces/${workspaceId}/tensions?status=OPEN`,
      label: t("attentionTensions"),
      counts: workAttentionCounts.tensions,
      complete: tensionWindow.complete,
    },
  ];

  // Release all original page and family observations together after the final async join.
  await release.finish(undefined);

  return (
    <>
      <header className="nr-masthead nr-newspaper-masthead">
        <div className="nr-newspaper-masthead-main">
          <div>
            <h1>{branding.primaryName}</h1>
            <div className="nr-newspaper-date" suppressHydrationWarning>
              <span>{dateString}</span>
              <span>{timeString}</span>
            </div>
          </div>
          <form action={`/workspaces/${workspaceId}/brain`} method="GET" className="nr-masthead-search nr-newspaper-search">
            <label htmlFor="workspace-newspaper-search">{t("searchLabel")}</label>
            <input
              id="workspace-newspaper-search"
              name="q"
              type="text"
              placeholder={t("searchPlaceholder")}
            />
          </form>
        </div>
      </header>

      <div className="nr-newspaper-actions">
        <Link href={`/workspaces/${workspaceId}/notifications`} className="nr-newspaper-action-button nr-newspaper-notification-pill">
          {notificationLabel}
        </Link>
      </div>

      {limitedSnapshot && <p role="status">{t("limitedSnapshot")}</p>}

      <section className="nr-home-attention-strip" aria-label={t("attentionStripLabel")}>
        {attentionTiles.map((tile) => {
          const hasPersonalCount = tile.counts.personalCount !== null;
          const personalLabel = notificationUnreadCountLabel({ count: tile.counts.personalCount ?? 0, complete: tile.complete && adviceComplete });
          const totalLabel = notificationUnreadCountLabel({ count: tile.counts.totalCount, complete: tile.complete });
          return (
            <Link
              key={tile.href}
              href={tile.href}
              className="nr-home-attention-tile"
            >
              <span className="nr-home-attention-title">{tile.label}</span>
              <span className={`nr-home-attention-metrics ${hasPersonalCount ? "" : "nr-home-attention-metrics-single"}`}>
                {hasPersonalCount && (
                  <span className="nr-home-attention-metric">
                    <strong>{personalLabel}</strong>
                    <span>{t("attentionForYou")}</span>
                  </span>
                )}
                <span className="nr-home-attention-metric">
                  <strong>{totalLabel}</strong>
                  <span>{t("attentionTotalOpen")}</span>
                </span>
              </span>
            </Link>
          );
        })}
      </section>

      {currentMember && (
        <section className="nr-personal-newspaper" aria-labelledby="personal-newspaper-title">
          <div className="nr-personal-newspaper-heading">
            <div>
              <p className="nr-newspaper-kicker">{t("personalNewspaperKicker")}</p>
              <h2 id="personal-newspaper-title">{t("personalNewspaperTitle")}</h2>
              <p>{t("personalNewspaperSourceNote")}</p>
            </div>
            <Link href={`/workspaces/${workspaceId}/actions?scope=workspace&status=OPEN&status=IN_PROGRESS`}>
              {t("viewAllActions")}
            </Link>
          </div>
          {personalItems.length > 0 ? (
            <ol className="nr-personal-newspaper-list">
              {personalItems.slice(0, 8).map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link href={item.href}>{item.title}</Link>
                  <span>
                    {item.kind === "ACTION" ? t("personalSourceAction") : item.kind === "PROPOSAL" ? t("personalSourceProposal") : t("personalSourceTension")}
                    {" · "}
                    {item.reason === "advice" ? t("personalReasonAdvice") : item.reason === "owner" ? t("personalReasonOwner") : t("personalReasonAssigned")}
                    {" · "}
                    {item.status === "IN_PROGRESS" ? t("personalStatusInProgress") : t("personalStatusOpen")}
                    {item.dueAt ? ` · ${t("dueDate", { date: format.dateTime(item.dueAt, item.dueAtKind === "DATE"
                      ? { timeZone: "UTC", month: "short", day: "numeric" }
                      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) })}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="nr-personal-newspaper-empty">{t(personalComplete ? "personalNewspaperEmpty" : "snapshotEmpty")}</p>}
        </section>
      )}

      <article className="nr-newspaper-page">
        <header className="nr-newspaper-header">
          <p className="nr-newspaper-kicker">
            {displayedEditionLabel}
            {generatedAt && (
              <>
                <span> · </span>
                <span suppressHydrationWarning>
                  {t("generatedOn", {
                    date: format.dateTime(generatedAt, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }),
                  })}
                </span>
              </>
            )}
          </p>
          <h2>{articleTitle}</h2>
        </header>

        {displayedBriefing ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={displayedBriefing.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={displayedBriefing.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={displayedBriefing.bodyMd} />
            <NewspaperSection title={t("newspaperSectionAttention")} markdown={displayedBriefing.attentionMd} />
            <NewspaperSection title={t("newspaperSectionContinuing")} markdown={displayedBriefing.continuingContextMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={displayedBriefing.closingMd} className="nr-newspaper-closing" />
          </div>
        ) : fallbackNarrative ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={fallbackNarrative.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={fallbackNarrative.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={fallbackNarrative.bodyMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={fallbackNarrative.closingMd} className="nr-newspaper-closing" />
            {latestNewspaperEdition && (
              <p>
                <Link href={`/workspaces/${workspaceId}/brain/${latestNewspaperEdition.slug}`} className="nr-newspaper-action-button nr-newspaper-inline-button">
                  {t("readFullEdition")}
                </Link>
              </p>
            )}
          </div>
        ) : liveNarrative ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={liveNarrative.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={liveNarrative.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={liveNarrative.bodyMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={liveNarrative.closingMd} className="nr-newspaper-closing" />
          </div>
        ) : (
          <div className="nr-newspaper-body">
            <p>{t(limitedSnapshot ? "limitedSnapshot" : "newspaperEmptyBody")}</p>
          </div>
        )}

        {sourceRefs.length ? (
          <footer className="nr-newspaper-sources">
            <span>{t("sourceTrail")}</span>
            <div>
              {sourceRefs.slice(0, 12).map((ref) => {
                if (!ref.href) return <span key={`${ref.type}-${ref.id}`}>{ref.label}</span>;
                return isExternalHref(ref.href) ? (
                  <a key={`${ref.type}-${ref.id}`} href={ref.href} target="_blank" rel="noopener noreferrer">
                    {ref.label}
                  </a>
                ) : (
                  <Link key={`${ref.type}-${ref.id}`} href={ref.href}>
                    {ref.label}
                  </Link>
                );
              })}
            </div>
          </footer>
        ) : null}
      </article>

      {!hasArticle && (
        <p className="nr-newspaper-empty">
          {t(limitedSnapshot ? "limitedSnapshot" : "newspaperWaiting")}
        </p>
      )}

      <div className="nr-footer">
        {t("footerStats", {
          articles: notificationUnreadCountLabel(articleWindow),
          meetings: notificationUnreadCountLabel(meetingWindow),
          chunks: notificationUnreadCountLabel(chunksSummary),
          members: membersCount,
        })}
      </div>
    </>
  );
}
