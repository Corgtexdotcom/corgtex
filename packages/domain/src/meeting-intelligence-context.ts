import { Prisma, type ActionStatus, type KnowledgeSourceType, type ProposalStatus, type SensitivityLabel, type TensionStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

export type MeetingIntelligenceContextMode = "summary" | "insights" | "agenda";

const CONTEXT_KNOWLEDGE_SOURCE_TYPES: KnowledgeSourceType[] = [
  "MEETING",
  "PROPOSAL",
  "TENSION",
  "ACTION",
  "DOCUMENT",
  "BRAIN_ARTICLE",
  "EVENT",
  "SLACK",
  "CIRCLE",
  "ROLE",
];

type ContextMeetingRecord = {
  id: string;
  workspaceId: string;
  title: string | null;
  source: string;
  transcript: string | null;
  summaryMd: string | null;
  ingestionGuidanceMd: string | null;
  recordedAt: Date;
  scheduledEndAt: Date | null;
  seriesId: string | null;
  series: { title: string | null } | null;
  participantIds: string[];
  participantEmails: string[];
};

type ContextMemberRecord = {
  id: string;
  user: { displayName: string | null; email: string };
  roleAssignments: Array<{
    role: {
      circleId: string | null;
      circle: { name: string } | null;
    };
  }>;
};

type ContextTensionRecord = {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  circleId: string | null;
  bodyMd: string | null;
  upvotes: unknown[];
  circle: { name: string } | null;
  assigneeMember: { user: { displayName: string | null; email: string } } | null;
  raisedByMember: { user: { displayName: string | null; email: string } } | null;
};

type ContextActionRecord = {
  id: string;
  title: string;
  status: string;
  circleId: string | null;
  bodyMd: string | null;
  dueAt: Date | null;
  circle: { name: string } | null;
  assigneeMember: { user: { displayName: string | null; email: string } } | null;
};

type ContextProposalRecord = {
  id: string;
  title: string;
  status: string;
  circleId: string | null;
  summary: string | null;
  bodyMd: string;
  circle: { name: string } | null;
  author: { displayName: string | null; email: string } | null;
  tensions: Array<{ id: string; title: string; status: string }>;
  actions: Array<{ id: string; title: string; status: string }>;
};

type ContextPreviousMeetingRecord = {
  id: string;
  title: string | null;
  recordedAt: Date;
  summaryMd: string | null;
  decisionsJson: unknown;
};

type ContextFollowUpRecord = {
  id: string;
  meetingId: string;
  title: string;
  bodyMd: string;
  assigneeHint: string | null;
};

type ContextDeliberationEntryRecord = {
  id: string;
  parentType: string;
  parentId: string;
  entryType: string;
  bodyMd: string;
  author: { displayName: string | null; email: string } | null;
  createdAt: Date;
};

type ContextKnowledgeChunkRecord = {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  content: string;
  sensitivity: SensitivityLabel;
};

type ContextKnowledgeResult = {
  chunkId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  chunkIndex: number;
  snippet: string;
  score: number;
};

type AllowedKnowledgeSources = Partial<Record<KnowledgeSourceType, string[]>>;

export type MeetingIntelligenceContext = {
  contextualIntelligenceEnabled: boolean;
  meeting: {
    id: string;
    workspaceId: string;
    title: string | null;
    source: string;
    transcript: string | null;
    summaryMd: string | null;
    ingestionGuidanceMd: string | null;
    recordedAt: Date;
    scheduledEndAt: Date | null;
    seriesId: string | null;
    seriesTitle: string | null;
    participantIds: string[];
    participantEmails: string[];
  };
  attendees: Array<{ memberId: string; name: string | null; email: string; circles: string[] }>;
  previousMeetings: Array<{
    id: string;
    title: string | null;
    recordedAt: string;
    summaryMd: string | null;
    decisionsJson: unknown;
  }>;
  tensions: Array<{
    id: string;
    title: string;
    status: string;
    priority: number | null;
    upvotes: number;
    circle: string | null;
    owner: string | null;
    bodyMd: string | null;
  }>;
  actions: Array<{
    id: string;
    title: string;
    status: string;
    dueAt: string | null;
    circle: string | null;
    owner: string | null;
    bodyMd: string | null;
  }>;
  proposals: Array<{
    id: string;
    title: string;
    status: string;
    summary: string | null;
    bodyMd: string;
    circle: string | null;
    author: string | null;
    tensions: Array<{ id: string; title: string; status: string }>;
    actions: Array<{ id: string; title: string; status: string }>;
  }>;
  followUps: Array<{ id: string; meetingId: string; title: string; bodyMd: string; owner: string | null }>;
  deliberationEntries: Array<{
    id: string;
    parentType: string;
    parentId: string;
    entryType: string;
    bodyMd: string;
    author: string | null;
    createdAt: string;
  }>;
  knowledgeSearchQuery: string;
  knowledge: ContextKnowledgeResult[];
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "for",
  "from",
  "have",
  "into",
  "meeting",
  "next",
  "not",
  "now",
  "open",
  "our",
  "the",
  "this",
  "that",
  "with",
]);

function userLabel(user?: { displayName?: string | null; email?: string | null } | null) {
  return user?.displayName || user?.email || null;
}

function normalizeTokens(value: string) {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu) ?? [])
    .filter((token) => !STOP_WORDS.has(token)))].slice(0, 80);
}

function lexicalScore(tokens: string[], content: string, title?: string | null) {
  if (tokens.length === 0) return 0;
  const haystack = `${title ?? ""}\n${content}`.toLowerCase();
  return tokens.reduce((score, token) => {
    if (!haystack.includes(token)) return score;
    return score + (title?.toLowerCase().includes(token) ? 3 : 1);
  }, 0);
}

function snippet(value: string, max = 500) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3).trim()}...` : compact;
}

function uniqueIds(ids: Array<string | null | undefined>) {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function compactAllowedSources(sources: AllowedKnowledgeSources) {
  return Object.fromEntries(
    (Object.entries(sources) as [KnowledgeSourceType, string[]][])
      .map(([sourceType, ids]) => [sourceType, uniqueIds(ids)] as const)
      .filter(([, ids]) => ids.length > 0),
  ) as AllowedKnowledgeSources;
}

function knowledgeSourceWhere(allowedSources: AllowedKnowledgeSources): Prisma.KnowledgeChunkWhereInput {
  const clauses = (Object.entries(allowedSources) as [KnowledgeSourceType, string[]][])
    .filter(([, ids]) => ids.length > 0)
    .map(([sourceType, ids]) => ({
      sourceType,
      sourceId: { in: ids },
    }));

  return clauses.length > 0 ? { OR: clauses } : { id: { in: [] } };
}

function isAllowedKnowledgeChunk(chunk: ContextKnowledgeChunkRecord, allowedSources: AllowedKnowledgeSources) {
  const ids = allowedSources[chunk.sourceType] ?? [];
  return chunk.sensitivity === "PUBLIC" && ids.includes(chunk.sourceId);
}

async function isContextualMeetingIntelligenceEnabled(workspaceId: string) {
  const flag = await prisma.workspaceFeatureFlag.findUnique({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: "MEETING_CONTEXTUAL_INTELLIGENCE",
      },
    },
    select: { enabled: true },
  });
  return flag?.enabled === true;
}

async function searchContextKnowledge(params: {
  workspaceId: string;
  query: string;
  allowedSources: AllowedKnowledgeSources;
}) {
  const tokens = normalizeTokens(params.query);
  if (tokens.length === 0) return [];

  const allowedSources = compactAllowedSources(params.allowedSources);
  if (Object.keys(allowedSources).length === 0) return [];

  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      workspaceId: params.workspaceId,
      sensitivity: "PUBLIC",
      sourceType: { in: CONTEXT_KNOWLEDGE_SOURCE_TYPES },
      ...knowledgeSourceWhere(allowedSources),
    },
    orderBy: [{ createdAt: "desc" }, { chunkIndex: "asc" }],
    take: 300,
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceTitle: true,
      chunkIndex: true,
      content: true,
      sensitivity: true,
    },
  }) as ContextKnowledgeChunkRecord[];

  return chunks
    .filter((chunk) => isAllowedKnowledgeChunk(chunk, allowedSources))
    .map((chunk) => ({
      chunk,
      score: lexicalScore(tokens, chunk.content, chunk.sourceTitle),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map(({ chunk, score }) => ({
      chunkId: chunk.id,
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      title: chunk.sourceTitle,
      chunkIndex: chunk.chunkIndex,
      snippet: snippet(chunk.content),
      score,
    }));
}

async function buildAllowedKnowledgeSources(params: {
  workspaceId: string;
  meetingIds: string[];
  actionIds: string[];
  tensionIds: string[];
  proposalIds: string[];
  circleIds: string[];
}) {
  const publicAggregateIds = uniqueIds([
    ...params.meetingIds,
    ...params.actionIds,
    ...params.tensionIds,
    ...params.proposalIds,
  ]);
  const [documents, brainArticles, circles, roles, events, publicSlackChannels] = await Promise.all([
    prisma.document.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 80,
    }),
    prisma.brainArticle.findMany({
      where: {
        workspaceId: params.workspaceId,
        isPrivate: false,
        publishedAt: { not: null },
        archivedAt: null,
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 80,
    }),
    prisma.circle.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { id: true },
      orderBy: { sortOrder: "asc" },
      take: 80,
    }),
    prisma.role.findMany({
      where: {
        archivedAt: null,
        circle: {
          workspaceId: params.workspaceId,
          archivedAt: null,
        },
      },
      select: { id: true },
      orderBy: { sortOrder: "asc" },
      take: 80,
    }),
    publicAggregateIds.length > 0
      ? prisma.event.findMany({
        where: {
          workspaceId: params.workspaceId,
          aggregateId: { in: publicAggregateIds },
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        take: 80,
      })
      : Promise.resolve([]),
    prisma.communicationChannel.findMany({
      where: {
        workspaceId: params.workspaceId,
        provider: "SLACK",
        kind: "PUBLIC",
        isIngestEnabled: true,
        isArchived: false,
      },
      select: { installationId: true, externalChannelId: true },
      take: 80,
    }),
  ]);

  const slackChannelOr = publicSlackChannels.map((channel) => ({
    installationId: channel.installationId,
    externalChannelId: channel.externalChannelId,
  }));
  const slackMessages = slackChannelOr.length > 0
    ? await prisma.communicationMessage.findMany({
      where: {
        workspaceId: params.workspaceId,
        provider: "SLACK",
        OR: slackChannelOr,
        text: { not: null },
        textRedactedAt: null,
        isBot: false,
        isHidden: false,
        isDeleted: false,
      },
      select: { id: true },
      orderBy: { receivedAt: "desc" },
      take: 120,
    })
    : [];

  return compactAllowedSources({
    MEETING: params.meetingIds,
    ACTION: params.actionIds,
    TENSION: params.tensionIds,
    PROPOSAL: params.proposalIds,
    DOCUMENT: documents.map((document) => document.id),
    BRAIN_ARTICLE: brainArticles.map((article) => article.id),
    EVENT: events.map((event) => event.id),
    CIRCLE: uniqueIds([...params.circleIds, ...circles.map((circle) => circle.id)]),
    ROLE: roles.map((role) => role.id),
    SLACK: slackMessages.map((message) => message.id),
  });
}

function buildKnowledgeQuery(params: {
  meeting: {
    title: string | null;
    transcript: string | null;
    summaryMd: string | null;
    ingestionGuidanceMd: string | null;
  };
  previousMeetings: Array<{ title: string | null; summaryMd: string | null }>;
  tensions: Array<{ title: string }>;
  actions: Array<{ title: string }>;
  proposals: Array<{ title: string; summary: string | null }>;
}) {
  return [
    params.meeting.title,
    params.meeting.ingestionGuidanceMd,
    params.meeting.summaryMd,
    params.meeting.transcript?.slice(0, 2000),
    ...params.previousMeetings.flatMap((meeting) => [meeting.title, meeting.summaryMd]),
    ...params.tensions.map((tension) => tension.title),
    ...params.actions.map((action) => action.title),
    ...params.proposals.flatMap((proposal) => [proposal.title, proposal.summary]),
  ].filter(Boolean).join("\n");
}

function contextMeeting(meeting: ContextMeetingRecord) {
  return {
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    title: meeting.title,
    source: meeting.source,
    transcript: meeting.transcript,
    summaryMd: meeting.summaryMd,
    ingestionGuidanceMd: meeting.ingestionGuidanceMd,
    recordedAt: meeting.recordedAt,
    scheduledEndAt: meeting.scheduledEndAt,
    seriesId: meeting.seriesId,
    seriesTitle: meeting.series?.title ?? null,
    participantIds: meeting.participantIds,
    participantEmails: meeting.participantEmails,
  };
}

function emptyContext(meeting: ContextMeetingRecord, contextualIntelligenceEnabled: boolean): MeetingIntelligenceContext {
  return {
    contextualIntelligenceEnabled,
    meeting: contextMeeting(meeting),
    attendees: [],
    previousMeetings: [],
    tensions: [],
    actions: [],
    proposals: [],
    followUps: [],
    deliberationEntries: [],
    knowledgeSearchQuery: "",
    knowledge: [],
  };
}

export async function buildMeetingIntelligenceContext(params: {
  workspaceId: string;
  meetingId: string;
  mode: MeetingIntelligenceContextMode;
}): Promise<MeetingIntelligenceContext> {
  const meeting = await prisma.meeting.findFirst({
    where: {
      id: params.meetingId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    include: { series: true },
  }) as ContextMeetingRecord | null;
  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");

  const contextualIntelligenceEnabled = params.mode === "agenda"
    ? true
    : await isContextualMeetingIntelligenceEnabled(params.workspaceId);
  if (params.mode === "summary" && !contextualIntelligenceEnabled) {
    return emptyContext(meeting, contextualIntelligenceEnabled);
  }

  const participantEmails = meeting.participantEmails.map((email) => email.toLowerCase());
  const memberOr = [
    meeting.participantIds.length > 0 ? { id: { in: meeting.participantIds } } : null,
    meeting.participantIds.length > 0 ? { userId: { in: meeting.participantIds } } : null,
    participantEmails.length > 0 ? { user: { email: { in: participantEmails } } } : null,
  ].filter(Boolean) as Prisma.MemberWhereInput[];

  const members = await prisma.member.findMany({
    where: {
      workspaceId: params.workspaceId,
      isActive: true,
      ...(memberOr.length > 0 ? { OR: memberOr } : { id: { in: [] } }),
    },
    include: {
      user: { select: { displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: {
            select: {
              circleId: true,
              circle: { select: { name: true } },
            },
          },
        },
      },
    },
  }) as ContextMemberRecord[];

  const memberIds = members.map((member) => member.id);
  const circleIds = [...new Set(members
    .flatMap((member) => member.roleAssignments.map((assignment) => assignment.role.circleId))
    .filter((circleId): circleId is string => Boolean(circleId)))];
  const scopedOr = [
    circleIds.length > 0 ? { circleId: { in: circleIds } } : null,
    memberIds.length > 0 ? { assigneeMemberId: { in: memberIds } } : null,
    memberIds.length > 0 ? { raisedByMemberId: { in: memberIds } } : null,
  ].filter(Boolean) as Prisma.TensionWhereInput[];
  const useScopedRecords = params.mode === "agenda" && scopedOr.length > 0;

  const previousMeetingOr = [
    meeting.seriesId ? { seriesId: meeting.seriesId } : null,
    meeting.title ? { title: meeting.title } : null,
  ].filter(Boolean) as Prisma.MeetingWhereInput[];
  const targetRecordLimit = params.mode === "agenda" ? 8 : params.mode === "insights" ? 50 : 30;
  const tensionStatuses: TensionStatus[] = params.mode === "agenda" ? ["OPEN"] : ["DRAFT", "OPEN"];
  const actionStatuses: ActionStatus[] = params.mode === "agenda" ? ["OPEN", "IN_PROGRESS"] : ["DRAFT", "OPEN", "IN_PROGRESS"];
  const proposalStatuses: ProposalStatus[] = params.mode === "agenda" ? ["OPEN"] : ["DRAFT", "OPEN"];
  const publishedFilter = params.mode === "agenda" ? { publishedAt: { not: null } } : {};

  const [tensions, actions, proposals, previousMeetings] = await Promise.all([
    prisma.tension.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: { in: tensionStatuses },
        isPrivate: false,
        ...publishedFilter,
        archivedAt: null,
        ...(useScopedRecords ? { OR: scopedOr } : {}),
      },
      include: {
        upvotes: true,
        circle: { select: { name: true } },
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
        raisedByMember: { include: { user: { select: { displayName: true, email: true } } } },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: targetRecordLimit,
    }),
    prisma.action.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: { in: actionStatuses },
        isPrivate: false,
        ...publishedFilter,
        archivedAt: null,
        ...(params.mode === "agenda" && (memberIds.length > 0 || circleIds.length > 0)
          ? {
            OR: [
              memberIds.length > 0 ? { assigneeMemberId: { in: memberIds } } : null,
              circleIds.length > 0 ? { circleId: { in: circleIds } } : null,
            ].filter(Boolean) as Prisma.ActionWhereInput[],
          }
          : {}),
      },
      include: {
        circle: { select: { name: true } },
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: targetRecordLimit,
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: { in: proposalStatuses },
        isPrivate: false,
        ...publishedFilter,
        archivedAt: null,
      },
      include: {
        author: { select: { displayName: true, email: true } },
        circle: { select: { name: true } },
        tensions: { select: { id: true, title: true, status: true } },
        actions: { select: { id: true, title: true, status: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: targetRecordLimit,
    }),
    previousMeetingOr.length > 0
      ? prisma.meeting.findMany({
        where: {
          workspaceId: params.workspaceId,
          id: { not: meeting.id },
          status: "COMPLETED",
          archivedAt: null,
          recordedAt: { lt: meeting.recordedAt },
          OR: previousMeetingOr,
        },
        orderBy: { recordedAt: "desc" },
        take: contextualIntelligenceEnabled ? 3 : 1,
        select: {
          id: true,
          title: true,
          recordedAt: true,
          summaryMd: true,
          decisionsJson: true,
        },
      })
      : Promise.resolve([]),
  ]) as [ContextTensionRecord[], ContextActionRecord[], ContextProposalRecord[], ContextPreviousMeetingRecord[]];

  const previousMeetingIds = previousMeetings.map((previousMeeting) => previousMeeting.id);
  const targetIds = [...proposals.map((proposal) => proposal.id), ...tensions.map((tension) => tension.id)];
  const [followUps, deliberationEntries] = await Promise.all([
    previousMeetingIds.length > 0
      ? prisma.meetingInsight.findMany({
        where: {
          workspaceId: params.workspaceId,
          meetingId: { in: previousMeetingIds },
          type: "FOLLOW_UP",
          status: { not: "DISMISSED" },
        },
        orderBy: { createdAt: "asc" },
        take: contextualIntelligenceEnabled ? 20 : 8,
      })
      : Promise.resolve([]),
    contextualIntelligenceEnabled && targetIds.length > 0
      ? prisma.deliberationEntry.findMany({
        where: {
          workspaceId: params.workspaceId,
          parentType: { in: ["PROPOSAL", "TENSION"] },
          parentId: { in: targetIds },
          resolvedAt: null,
        },
        include: {
          author: { select: { displayName: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      })
      : Promise.resolve([]),
  ]) as [ContextFollowUpRecord[], ContextDeliberationEntryRecord[]];

  const context = {
    contextualIntelligenceEnabled,
    meeting: contextMeeting(meeting),
    attendees: members.map((member) => ({
      memberId: member.id,
      name: userLabel(member.user),
      email: member.user.email,
      circles: member.roleAssignments
        .map((assignment) => assignment.role.circle?.name)
        .filter((name): name is string => Boolean(name)),
    })),
    previousMeetings: previousMeetings.map((previousMeeting) => ({
      id: previousMeeting.id,
      title: previousMeeting.title,
      recordedAt: previousMeeting.recordedAt.toISOString(),
      summaryMd: previousMeeting.summaryMd,
      decisionsJson: previousMeeting.decisionsJson,
    })),
    tensions: tensions.map((tension) => ({
      id: tension.id,
      title: tension.title,
      status: tension.status,
      priority: tension.priority,
      upvotes: tension.upvotes.length,
      circle: tension.circle?.name ?? null,
      owner: userLabel(tension.assigneeMember?.user) ?? userLabel(tension.raisedByMember?.user),
      bodyMd: tension.bodyMd,
    })),
    actions: actions.map((action) => ({
      id: action.id,
      title: action.title,
      status: action.status,
      dueAt: action.dueAt?.toISOString() ?? null,
      circle: action.circle?.name ?? null,
      owner: userLabel(action.assigneeMember?.user),
      bodyMd: action.bodyMd,
    })),
    proposals: proposals.map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      summary: proposal.summary,
      bodyMd: proposal.bodyMd,
      circle: proposal.circle?.name ?? null,
      author: userLabel(proposal.author),
      tensions: proposal.tensions,
      actions: proposal.actions,
    })),
    followUps: followUps.map((followUp) => ({
      id: followUp.id,
      meetingId: followUp.meetingId,
      title: followUp.title,
      bodyMd: followUp.bodyMd,
      owner: followUp.assigneeHint,
    })),
    deliberationEntries: deliberationEntries.map((entry) => ({
      id: entry.id,
      parentType: entry.parentType,
      parentId: entry.parentId,
      entryType: entry.entryType,
      bodyMd: entry.bodyMd,
      author: userLabel(entry.author),
      createdAt: entry.createdAt.toISOString(),
    })),
    knowledgeSearchQuery: "",
    knowledge: [] as ContextKnowledgeResult[],
  } satisfies MeetingIntelligenceContext;

  context.knowledgeSearchQuery = buildKnowledgeQuery({
    meeting: context.meeting,
    previousMeetings: context.previousMeetings,
    tensions: context.tensions,
    actions: context.actions,
    proposals: context.proposals,
  });
  const allowedKnowledgeSources = contextualIntelligenceEnabled && params.mode !== "agenda"
    ? await buildAllowedKnowledgeSources({
      workspaceId: params.workspaceId,
      meetingIds: uniqueIds([meeting.id, ...previousMeetingIds]),
      actionIds: actions.map((action) => action.id),
      tensionIds: tensions.map((tension) => tension.id),
      proposalIds: proposals.map((proposal) => proposal.id),
      circleIds: uniqueIds([
        ...circleIds,
        ...actions.map((action) => action.circleId),
        ...tensions.map((tension) => tension.circleId),
        ...proposals.map((proposal) => proposal.circleId),
      ]),
    })
    : {};
  context.knowledge = contextualIntelligenceEnabled && params.mode !== "agenda"
    ? await searchContextKnowledge({
      workspaceId: params.workspaceId,
      query: context.knowledgeSearchQuery,
      allowedSources: allowedKnowledgeSources,
    })
    : [];

  return context;
}
