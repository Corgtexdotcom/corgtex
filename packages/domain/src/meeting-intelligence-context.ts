import { assertMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";
import { Prisma, type ActionStatus, type KnowledgeSourceType, type ProposalStatus, type SensitivityLabel, type TensionStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import {
  advanceHumanArtifactInputLineage,
  captureArtifactInputProof,
  captureArtifactInputSnapshotProof,
  isArtifactInputProofReadable,
  lineageContentFingerprint,
  readableArtifactIds,
  preserveUnknownArtifactInputSnapshot,
  recordArtifactInputLineage,
  type LineageInput,
  type LineageRoot,
} from "./source-lineage";
import { requireWorkspaceMembership } from "./auth";
import { normalizeActionWorkItem, normalizeProposalWorkItem, normalizeTensionWorkItem } from "./work-item-normalization";

export type MeetingIntelligenceContextMode = "summary" | "insights" | "agenda";

const CONTEXT_KNOWLEDGE_SOURCE_TYPES: KnowledgeSourceType[] = [
  "MEETING",
  "PROPOSAL",
  "DOCUMENT",
  "BRAIN_ARTICLE",
];

export function meetingIntelligenceActor(workspaceId: string): AppActor {
  return { kind: "agent", authProvider: "bootstrap", label: "meeting-intelligence-context", workspaceIds: [workspaceId] };
}


export function meetingTranscriptInputProjection(meeting: Record<string, unknown>) {
  return Object.fromEntries(["id", "workspaceId", "title", "source", "externalId", "calendarExternalId",
    "meetingUrl", "meetingUrlHash", "transcript", "ingestionGuidanceMd", "recordedAt",
    "scheduledEndAt", "seriesId", "participantIds", "participantEmails", "archivedAt", "createdAt"]
    .map((field) => [field, meeting[field]]));
}

export function meetingAgendaInputProjection(meeting: Record<string, unknown>) {
  return Object.fromEntries(["id", "workspaceId", "agendaJson", "archivedAt", "createdAt"]
    .map((field) => [field, meeting[field]]));
}

type CapturedContextInput = LineageInput & { snapshot: Record<string, unknown> };

const MEETING_READ_BATCH_SIZE = 100;

type MeetingInputPage = { take: number; cursor?: { id: string }; skip?: number };

/** Limit SQL pages while applying permission checks before the requested result limit. */
export async function readMeetingInputBatches<T extends { id: string }>(
  readPage: (page: MeetingInputPage) => Promise<T[]>,
  admit: (rows: T[]) => Promise<T[]>,
  take?: number,
): Promise<T[]> {
  invariant(take === undefined || (Number.isSafeInteger(take) && take >= 0),
    400, "INVALID_INPUT", "Meeting result limit is invalid.");
  if (take === 0) return [];
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: { id: string } | undefined;
  while (true) {
    const batchSize = MEETING_READ_BATCH_SIZE;
    const rows = await readPage({ take: batchSize, ...(cursor ? { cursor, skip: 1 } : {}) });
    invariant(rows.length <= batchSize, 409, "SOURCE_CHANGED", "Meeting query returned an invalid page.");
    const fresh = rows.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    results.push(...await admit(fresh));
    if (take !== undefined && results.length >= take) return results.slice(0, take);
    if (rows.length < batchSize) return results;
    const next = rows.at(-1)!;
    invariant(next.id !== cursor?.id && fresh.length > 0, 409, "SOURCE_CHANGED", "Meeting inputs changed while reading.");
    cursor = { id: next.id };
  }
}

async function queryVisibleContextRows<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageInput["kind"], readPage: (page: MeetingInputPage) => Promise<T[]>, take?: number) {
  return readMeetingInputBatches(readPage, (rows) => visibleContextRows(actor, workspaceId, kind, rows), take);
}


async function visibleContextRows<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageInput["kind"], rows: T[], take?: number) {
  const readable = await readableArtifactIds(actor, workspaceId, kind, rows);
  const visible = rows.filter((row) => readable.has(row.id));
  return take === undefined ? visible : visible.slice(0, take);
}

type ContextMeetingRecord = {
  id: string;
  workspaceId: string;
  status: string;
  title: string | null;
  source: string;
  transcript: string | null;
  summaryMd: string | null;
  blocksJson: unknown;
  agendaJson: unknown;
  ingestionGuidanceMd: string | null;
  recordedAt: Date;
  scheduledEndAt: Date | null;
  seriesId: string | null;
  series: ({ id?: string; title: string | null; recurrenceRule: string | null } & Record<string, unknown>) | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  participantIds: string[];
  participantEmails: string[];
};

type ContextMemberRecord = {
  id: string;
  userId: string;
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
  assigneeMemberId: string | null;
  raisedByMemberId: string | null;
  upvotes: unknown[];
  circle: { name: string } | null;
  assigneeMember: { id: string; user: { displayName: string | null; email: string } } | null;
  raisedByMember: { id: string; user: { displayName: string | null; email: string } } | null;
};

type ContextActionRecord = {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  circleId: string | null;
  bodyMd: string | null;
  dueAt: Date | null;
  assigneeMemberId: string | null;
  circle: { name: string } | null;
  assigneeMember: { id: string; user: { displayName: string | null; email: string } } | null;
};

type ContextProposalRecord = {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  circleId: string | null;
  summary: string | null;
  bodyMd: string;
  circle: { name: string } | null;
  author: { displayName: string | null; email: string } | null;
  ownerMemberId: string | null;
  ownerMember: { id: string; user: { displayName: string | null; email: string } } | null;
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
  type?: string;
  operation?: string;
  status?: string;
  title: string;
  bodyMd: string;
  assigneeHint: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  appliedEntityType?: string | null;
  appliedEntityId?: string | null;
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
  metadata: Prisma.JsonValue | null;
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
  /** Complete pre-generation receipt. Legacy callers without this receipt must not persist model output. */
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
  sourceStateHash?: string;
  contextualIntelligenceEnabled: boolean;
  meeting: {
    id: string;
    workspaceId: string;
    title: string | null;
    source: string;
    status: string;
    transcript: string | null;
    summaryMd: string | null;
    blocksJson: unknown;
    agendaJson: unknown;
    ingestionGuidanceMd: string | null;
    recordedAt: Date;
    scheduledEndAt: Date | null;
    seriesId: string | null;
    seriesTitle: string | null;
    seriesRecurrenceRule: string | null;
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
    priorityLabel: string;
    upvotes: number;
    upvoteCount: number | null;
    circle: string | null;
    owner: string | null;
    ownerMemberId: string | null;
    ownerMemberName: string | null;
    responsibleMemberId: string | null;
    responsibleMemberName: string | null;
    bodyMd: string | null;
  }>;
  actions: Array<{
    id: string;
    title: string;
    status: string;
    priority: number | null;
    priorityLabel: string;
    dueAt: string | null;
    circle: string | null;
    owner: string | null;
    ownerMemberId: string | null;
    ownerMemberName: string | null;
    responsibleMemberId: string | null;
    responsibleMemberName: string | null;
    bodyMd: string | null;
  }>;
  proposals: Array<{
    id: string;
    title: string;
    status: string;
    priority: number | null;
    priorityLabel: string;
    summary: string | null;
    bodyMd: string;
    circle: string | null;
    author: string | null;
    owner: string | null;
    ownerMemberId: string | null;
    ownerMemberName: string | null;
    responsibleMemberId: string | null;
    responsibleMemberName: string | null;
    tensions: Array<{ id: string; title: string; status: string }>;
    actions: Array<{ id: string; title: string; status: string }>;
  }>;
  followUps: Array<{ id: string; meetingId: string; title: string; bodyMd: string; owner: string | null }>;
  resolvedTensions: Array<{ id: string; meetingId: string; title: string; bodyMd: string; targetEntityId: string | null }>;
  createdFromPreviousMeeting: Array<{ meetingId: string; entityType: string; entityId: string }>;
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
  actor: AppActor;
  capture: (kind: LineageInput["kind"], rows: Array<{ id: string }>) => void;
  workspaceId: string;
  query: string;
  allowedSources: AllowedKnowledgeSources;
}) {
  const tokens = normalizeTokens(params.query);
  if (tokens.length === 0) return [];

  const allowedSources = compactAllowedSources(params.allowedSources);
  if (Object.keys(allowedSources).length === 0) return [];

  const visibleChunks = await queryVisibleContextRows(params.actor, params.workspaceId, "KnowledgeChunk", (page) => prisma.knowledgeChunk.findMany({
    where: {
      workspaceId: params.workspaceId,
      sensitivity: "PUBLIC",
      accessDomain: "WORKSPACE",
      sourceType: { in: CONTEXT_KNOWLEDGE_SOURCE_TYPES },
      ...knowledgeSourceWhere(allowedSources),
    },
    orderBy: [{ createdAt: "desc" }, { chunkIndex: "asc" }, { id: "asc" }],
    ...page,
  }));

  const results = visibleChunks
    .filter((chunk) => isAllowedKnowledgeChunk(chunk, allowedSources))
    .map((chunk) => ({
      chunk,
      score: lexicalScore(tokens, chunk.content, chunk.sourceTitle),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map(({ chunk, score }) => {
      params.capture("KnowledgeChunk", [chunk]);
      return ({
      chunkId: chunk.id,
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      title: chunk.sourceTitle,
      chunkIndex: chunk.chunkIndex,
      snippet: snippet(chunk.content),
      score,
    }); });
  return results;
}

async function buildAllowedKnowledgeSources(params: {
  actor: AppActor;
  workspaceId: string;
  meetingIds: string[];
  actionIds: string[];
  tensionIds: string[];
  proposalIds: string[];
  circleIds: string[];
}) {
  const [documents, articles] = await Promise.all([
    queryVisibleContextRows(params.actor, params.workspaceId, "Document", (page) => prisma.document.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], ...page,
    }), 80),
    queryVisibleContextRows(params.actor, params.workspaceId, "BrainArticle", (page) => prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, isPrivate: false, publishedAt: { not: null }, archivedAt: null },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }], ...page,
    }), 80),
  ]);
  return compactAllowedSources({ MEETING: params.meetingIds, PROPOSAL: params.proposalIds,
    DOCUMENT: documents.map((row) => row.id), BRAIN_ARTICLE: articles.map((row) => row.id) });
}

function buildKnowledgeQuery(params: {
  meeting: {
    title: string | null;
    transcript: string | null;
    summaryMd: string | null;
    blocksJson?: unknown;
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
    params.meeting.blocksJson ? JSON.stringify(params.meeting.blocksJson).slice(0, 2000) : null,
    params.meeting.transcript?.slice(0, 2000),
    ...params.previousMeetings.flatMap((meeting) => [meeting.title, meeting.summaryMd]),
    ...params.tensions.map((tension) => tension.title),
    ...params.actions.map((action) => action.title),
    ...params.proposals.flatMap((proposal) => [proposal.title, proposal.summary]),
  ].filter(Boolean).join("\n");
}

function contextMeeting(meeting: ContextMeetingRecord) {
  const participantIds = meeting.participantIds ?? [];
  const participantEmails = meeting.participantEmails ?? [];
  return {
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    title: meeting.title,
    source: meeting.source,
    status: meeting.status,
    transcript: meeting.transcript,
    summaryMd: meeting.summaryMd,
    blocksJson: meeting.blocksJson,
    agendaJson: meeting.agendaJson,
    ingestionGuidanceMd: meeting.ingestionGuidanceMd,
    recordedAt: meeting.recordedAt,
    scheduledEndAt: meeting.scheduledEndAt,
    seriesId: meeting.seriesId,
    seriesTitle: meeting.series?.title ?? null,
    seriesRecurrenceRule: meeting.series?.recurrenceRule ?? null,
    participantIds,
    participantEmails,
  };
}

function attendeeOrderRanker(meeting: ContextMeetingRecord) {
  const participantIds = new Map((meeting.participantIds ?? []).map((id, index) => [id, index]));
  const participantEmails = new Map((meeting.participantEmails ?? []).map((email, index) => [email.toLowerCase(), index]));
  return (member: ContextMemberRecord) => (
    participantIds.get(member.id)
    ?? participantIds.get(member.userId)
    ?? participantEmails.get(member.user.email.toLowerCase())
    ?? Number.MAX_SAFE_INTEGER
  );
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
    resolvedTensions: [],
    createdFromPreviousMeeting: [],
    deliberationEntries: [],
    knowledgeSearchQuery: "",
    knowledge: [],
  };
}

export async function buildMeetingIntelligenceContext(params: {
  actor?: AppActor;
  workspaceId: string;
  meetingId: string;
  mode: MeetingIntelligenceContextMode;
}): Promise<MeetingIntelligenceContext> {
  const actor = params.actor ?? meetingIntelligenceActor(params.workspaceId);
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const loadedMeeting = await prisma.meeting.findFirst({
    where: {
      id: params.meetingId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    include: { series: true },
  }) as ContextMeetingRecord | null;
  invariant(loadedMeeting, 404, "NOT_FOUND", "Meeting not found.");
  const sourceStateHash = lineageContentFingerprint("Meeting", loadedMeeting);
  const rawInput = meetingTranscriptInputProjection(loadedMeeting);
  invariant((await visibleContextRows(actor, params.workspaceId, "MeetingTranscript", [rawInput as { id: string }])).length,
    404, "NOT_FOUND", "Meeting not found.");
  const captureInputs = new Map<string, CapturedContextInput>();
  const capture = (kind: LineageInput["kind"], rows: Array<{ id: string }>) => {
    for (const row of rows) captureInputs.set(`${kind}:${row.id}`, { kind, id: row.id, snapshot: row as Record<string, unknown> });
  };
  capture("MeetingTranscript", [rawInput as { id: string }]);
  const hasDerivedReceipt = (await visibleContextRows(actor, params.workspaceId, "Meeting", [loadedMeeting])).length > 0;
  invariant(params.mode !== "insights" || hasDerivedReceipt, 404, "NOT_FOUND", "Meeting not found.");
  if (hasDerivedReceipt) capture("Meeting", [loadedMeeting]);
  const agendaInput = meetingAgendaInputProjection(loadedMeeting);
  const agendaVisible = loadedMeeting.agendaJson != null
    && (await visibleContextRows(actor, params.workspaceId, "MeetingAgenda", [agendaInput as { id: string }])).length > 0;
  if (agendaVisible) capture("MeetingAgenda", [agendaInput as { id: string }]);
  const seriesVisible = loadedMeeting.seriesId && loadedMeeting.series
    && (await visibleContextRows(actor, params.workspaceId, "MeetingSeries", [{ ...loadedMeeting.series, id: loadedMeeting.seriesId }])).length > 0;
  if (seriesVisible) capture("MeetingSeries", [{ ...loadedMeeting.series!, id: loadedMeeting.seriesId! }]);
  const meeting: ContextMeetingRecord = { ...loadedMeeting,
    summaryMd: hasDerivedReceipt ? loadedMeeting.summaryMd : null,
    blocksJson: hasDerivedReceipt ? loadedMeeting.blocksJson : null,
    agendaJson: agendaVisible ? loadedMeeting.agendaJson : null,
    series: seriesVisible ? loadedMeeting.series : null,
  };
  const finish = async (context: MeetingIntelligenceContext) => ({ ...context, sourceStateHash,
    lineageInputs: [...captureInputs.values()].map(({ kind, id }) => ({ kind, id })),
    lineageRoots: await captureArtifactInputProof(actor, params.workspaceId, [...captureInputs.values()]),
  });

  const contextualIntelligenceEnabled = params.mode === "agenda"
    ? true
    : await isContextualMeetingIntelligenceEnabled(params.workspaceId);
  if (params.mode === "summary" && !contextualIntelligenceEnabled) {
    return finish(emptyContext(meeting, contextualIntelligenceEnabled));
  }

  const participantIds = meeting.participantIds ?? [];
  const participantEmails = (meeting.participantEmails ?? []).map((email) => email.toLowerCase());
  const memberOr = [
    participantIds.length > 0 ? { id: { in: participantIds } } : null,
    participantIds.length > 0 ? { userId: { in: participantIds } } : null,
    participantEmails.length > 0 ? { user: { email: { in: participantEmails } } } : null,
  ].filter(Boolean) as Prisma.MemberWhereInput[];

  const candidateMembers = await queryVisibleContextRows(actor, params.workspaceId, "Member", (page) => prisma.member.findMany({
    where: {
      workspaceId: params.workspaceId,
      isActive: true,
      ...(memberOr.length > 0 ? { OR: memberOr } : { id: { in: [] } }),
    },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: { include: { circle: true } },
        },
      },
    },
    orderBy: { id: "asc" }, ...page,
  })) as ContextMemberRecord[];

  const members = await visibleContextRows(actor, params.workspaceId, "Member", candidateMembers);
  capture("Member", members);
  const memberRoleRows = members.flatMap((member) => member.roleAssignments.map((assignment) => assignment.role)) as unknown as Array<{ id: string }>;
  const visibleRoles = new Set((await visibleContextRows(actor, params.workspaceId, "Role", memberRoleRows.filter((role) => role.id))).map((role) => role.id));
  capture("Role", memberRoleRows.filter((role) => visibleRoles.has(role.id)));
  const allCircles = memberRoleRows.flatMap((role) => (role as any).circle ? [(role as any).circle] : []) as Array<{ id: string }>;
  const circleVisibility = new Set((await visibleContextRows(actor, params.workspaceId, "Circle", allCircles.filter((circle) => circle.id))).map((circle) => circle.id));
  capture("Circle", allCircles.filter((circle) => circleVisibility.has(circle.id)));
  for (const member of members) member.roleAssignments = member.roleAssignments.filter((assignment) =>
    visibleRoles.has((assignment.role as any).id) && circleVisibility.has((assignment.role.circle as any)?.id));
  capture("RoleAssignment", members.flatMap((member) => member.roleAssignments).filter((assignment) => (assignment as any).id) as unknown as Array<{ id: string }>);

  const attendeeRank = attendeeOrderRanker(meeting);
  const orderedMembers = [...members].sort((left, right) => {
    const rank = attendeeRank(left) - attendeeRank(right);
    if (rank !== 0) return rank;
    return (userLabel(left.user) ?? "").localeCompare(userLabel(right.user) ?? "");
  });
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
  const previousMeetingLimit = params.mode === "agenda" ? 10 : contextualIntelligenceEnabled ? 3 : 1;
  const tensionStatuses: TensionStatus[] = params.mode === "agenda" ? ["OPEN"] : ["DRAFT", "OPEN"];
  const actionStatuses: ActionStatus[] = params.mode === "agenda" ? ["OPEN", "IN_PROGRESS"] : ["DRAFT", "OPEN", "IN_PROGRESS"];
  const proposalStatuses: ProposalStatus[] = params.mode === "agenda" ? ["OPEN"] : ["DRAFT", "OPEN"];
  const publishedFilter = params.mode === "agenda" ? { publishedAt: { not: null } } : {};

  const [candidateTensions, candidateActions, candidateProposals, candidatePreviousMeetings] = await Promise.all([
    queryVisibleContextRows(actor, params.workspaceId, "Tension", (page) => prisma.tension.findMany({
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
        circle: true,
        assigneeMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
        raisedByMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }], ...page,
    }), targetRecordLimit),
    queryVisibleContextRows(actor, params.workspaceId, "Action", (page) => prisma.action.findMany({
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
        circle: true,
        assigneeMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }, { id: "asc" }], ...page,
    }), targetRecordLimit),
    queryVisibleContextRows(actor, params.workspaceId, "Proposal", (page) => prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        status: { in: proposalStatuses },
        isPrivate: false,
        ...publishedFilter,
        archivedAt: null,
      },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        ownerMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
        circle: true,
        tensions: true,
        actions: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }], ...page,
    }), targetRecordLimit),
    previousMeetingOr.length > 0
      ? queryVisibleContextRows(actor, params.workspaceId, "Meeting", (page) => prisma.meeting.findMany({
        where: {
          workspaceId: params.workspaceId,
          id: { not: meeting.id },
          status: "COMPLETED",
          archivedAt: null,
          recordedAt: { lt: meeting.recordedAt },
          OR: previousMeetingOr,
        },
        orderBy: [{ recordedAt: "desc" }, { id: "asc" }], ...page,
      }), previousMeetingLimit)
      : Promise.resolve([]),
  ]) as [ContextTensionRecord[], ContextActionRecord[], ContextProposalRecord[], ContextPreviousMeetingRecord[]];
  const [tensions, actions, proposals, previousMeetings] = await Promise.all([
    visibleContextRows(actor, params.workspaceId, "Tension", candidateTensions, targetRecordLimit),
    visibleContextRows(actor, params.workspaceId, "Action", candidateActions, targetRecordLimit),
    visibleContextRows(actor, params.workspaceId, "Proposal", candidateProposals, targetRecordLimit),
    visibleContextRows(actor, params.workspaceId, "Meeting", candidatePreviousMeetings, previousMeetingLimit),
  ]);
  capture("Tension", tensions); capture("Action", actions); capture("Proposal", proposals); capture("Meeting", previousMeetings);
  capture("TensionUpvote", tensions.flatMap((tension) => tension.upvotes) as Array<{ id: string }>);
  for (const proposal of proposals) {
    proposal.tensions = await visibleContextRows(actor, params.workspaceId, "Tension", proposal.tensions);
    proposal.actions = await visibleContextRows(actor, params.workspaceId, "Action", proposal.actions);
    capture("Tension", proposal.tensions); capture("Action", proposal.actions);
  }

  const previousMeetingIds = previousMeetings.map((previousMeeting) => previousMeeting.id);
  const targetIds = [...proposals.map((proposal) => proposal.id), ...tensions.map((tension) => tension.id)];
  const [candidatePreviousInsights, candidateDeliberationEntries] = await Promise.all([
    previousMeetingIds.length > 0
      ? queryVisibleContextRows(actor, params.workspaceId, "MeetingInsight", (page) => prisma.meetingInsight.findMany({
        where: {
          workspaceId: params.workspaceId,
          meetingId: { in: previousMeetingIds },
          status: { not: "DISMISSED" },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], ...page,
      }), contextualIntelligenceEnabled ? 60 : 20)
      : Promise.resolve([]),
    contextualIntelligenceEnabled && targetIds.length > 0
      ? queryVisibleContextRows(actor, params.workspaceId, "DeliberationEntry", (page) => prisma.deliberationEntry.findMany({
        where: {
          workspaceId: params.workspaceId,
          parentType: { in: ["PROPOSAL", "TENSION"] },
          parentId: { in: targetIds },
          resolvedAt: null,
        },
        include: {
          author: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page,
      }), 30)
      : Promise.resolve([]),
  ]) as [ContextFollowUpRecord[], ContextDeliberationEntryRecord[]];

  const [previousInsights, deliberationEntries] = await Promise.all([
    visibleContextRows(actor, params.workspaceId, "MeetingInsight", candidatePreviousInsights, contextualIntelligenceEnabled ? 60 : 20),
    visibleContextRows(actor, params.workspaceId, "DeliberationEntry", candidateDeliberationEntries, 30),
  ]);
  capture("MeetingInsight", previousInsights); capture("DeliberationEntry", deliberationEntries);
  const contributingRows = [...members, ...tensions, ...actions, ...proposals, ...deliberationEntries] as unknown as Array<Record<string, any>>;
  const userRows: Array<{ id: string }> = [];
  const memberRows: Array<{ id: string }> = [];
  const circleRows: Array<{ id: string }> = [];
  for (const row of contributingRows) {
    if (row.user?.id) userRows.push(row.user);
    if (row.author?.id) userRows.push(row.author);
    for (const field of ["ownerMember", "assigneeMember", "raisedByMember"]) {
      if (row[field]?.id) memberRows.push(row[field]);
      if (row[field]?.user?.id) userRows.push(row[field].user);
    }
    if (row.circle?.id) circleRows.push(row.circle);
  }
  const [visibleUsers, visibleMembers, visibleCircles] = await Promise.all([
    visibleContextRows(actor, params.workspaceId, "User", userRows),
    visibleContextRows(actor, params.workspaceId, "Member", memberRows),
    visibleContextRows(actor, params.workspaceId, "Circle", circleRows),
  ]);
  capture("User", visibleUsers); capture("Member", visibleMembers); capture("Circle", visibleCircles);
  const userIds = new Set(visibleUsers.map((row) => row.id));
  const labelMemberIds = new Set(visibleMembers.map((row) => row.id));
  const labelCircleIds = new Set(visibleCircles.map((row) => row.id));
  for (const row of contributingRows) {
    if (row.author?.id && !userIds.has(row.author.id)) row.author = null;
    for (const field of ["ownerMember", "assigneeMember", "raisedByMember"]) {
      if (row[field]?.id && !labelMemberIds.has(row[field].id)) row[field] = null;
    }
    if (row.circle?.id && !labelCircleIds.has(row.circle.id)) row.circle = null;
  }

  const followUps = previousInsights.filter((insight) => insight.type === "FOLLOW_UP");
  const resolvedTensions = previousInsights.filter((insight) => (
    insight.operation === "RESOLVE"
    && insight.status === "APPLIED"
    && (insight.appliedEntityType === "Tension" || insight.targetEntityType === "Tension")
  ));
  const createdFromPreviousMeeting = previousInsights
    .filter((insight) => insight.operation === "CREATE" && insight.status === "APPLIED" && insight.appliedEntityType && insight.appliedEntityId)
    .map((insight) => ({
      meetingId: insight.meetingId,
      entityType: insight.appliedEntityType as string,
      entityId: insight.appliedEntityId as string,
    }));

  const context = {
    contextualIntelligenceEnabled,
    meeting: contextMeeting(meeting),
    attendees: orderedMembers.map((member) => ({
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
    tensions: tensions.map((tension) => {
      const item = normalizeTensionWorkItem(tension);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        priorityLabel: item.priorityLabel,
        upvotes: tension.upvotes.length,
        upvoteCount: item.upvoteCount,
        circle: tension.circle?.name ?? null,
        owner: item.owner,
        ownerMemberId: item.ownerMemberId,
        ownerMemberName: item.ownerMemberName,
        responsibleMemberId: item.responsibleMemberId,
        responsibleMemberName: item.responsibleMemberName,
        bodyMd: item.bodyMd,
      };
    }),
    actions: actions.map((action) => {
      const item = normalizeActionWorkItem(action);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        priorityLabel: item.priorityLabel,
        dueAt: action.dueAt?.toISOString() ?? null,
        circle: action.circle?.name ?? null,
        owner: item.owner,
        ownerMemberId: item.ownerMemberId,
        ownerMemberName: item.ownerMemberName,
        responsibleMemberId: item.responsibleMemberId,
        responsibleMemberName: item.responsibleMemberName,
        bodyMd: item.bodyMd,
      };
    }),
    proposals: proposals.map((proposal) => {
      const item = normalizeProposalWorkItem(proposal);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        priorityLabel: item.priorityLabel,
        summary: item.summary,
        bodyMd: item.bodyMd,
        circle: proposal.circle?.name ?? null,
        author: userLabel(proposal.author),
        owner: item.owner,
        ownerMemberId: item.ownerMemberId,
        ownerMemberName: item.ownerMemberName,
        responsibleMemberId: item.responsibleMemberId,
        responsibleMemberName: item.responsibleMemberName,
        tensions: proposal.tensions,
        actions: proposal.actions,
      };
    }),
    followUps: followUps.map((followUp) => ({
      id: followUp.id,
      meetingId: followUp.meetingId,
      title: followUp.title,
      bodyMd: followUp.bodyMd,
      owner: followUp.assigneeHint,
    })),
    resolvedTensions: resolvedTensions.map((insight) => ({
      id: insight.id,
      meetingId: insight.meetingId,
      title: insight.title,
      bodyMd: insight.bodyMd,
      targetEntityId: insight.appliedEntityId ?? insight.targetEntityId ?? null,
    })),
    createdFromPreviousMeeting,
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
      actor, workspaceId: params.workspaceId,
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
      actor, capture,
      workspaceId: params.workspaceId,
      query: context.knowledgeSearchQuery,
      allowedSources: allowedKnowledgeSources,
    })
    : [];

  return finish(context);
}


/** The source state guard detects edits to withheld legacy fields without using them as model inputs. */
export async function persistMeetingSummaryWithLineage(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  sourceStateHash: string;
  lineageInputs: LineageInput[];
  lineageRoots: LineageRoot[];
  summaryMd: string;
  blocksJson: Prisma.InputJsonValue;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(params.lineageInputs.some((input) => input.kind === "MeetingTranscript" && input.id === params.meetingId)
    && params.lineageRoots.length > 0, 409, "UNKNOWN_LINEAGE", "Meeting summary requires its complete prompt receipt.");
  return prisma.$transaction(async (tx) => {
    await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId, tx);
    await tx.$queryRaw`SELECT id FROM "Meeting" WHERE id = ${params.meetingId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const current = await tx.meeting.findFirst({ where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null } });
    if (!current) return { count: 0, reason: "missing_meeting" as const };
    if (lineageContentFingerprint("Meeting", current) !== params.sourceStateHash) {
      return { count: 0, reason: "source_changed" as const };
    }
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, params.lineageRoots, tx),
      409, "SOURCE_CHANGED", "Meeting summary inputs changed during generation.");
    const selfInputs = params.lineageInputs.filter((input) => input.kind === "Meeting" && input.id === params.meetingId);
    const inheritedRoots = params.lineageRoots.filter((root) => !(root.kind === "Meeting" && root.id === params.meetingId));
    for (const input of selfInputs) {
      const direct = params.lineageRoots.find((root) => root.kind === input.kind && root.id === input.id);
      invariant(direct, 409, "UNKNOWN_LINEAGE", "Prior meeting context has no captured revision.");
      inheritedRoots.push(...await captureArtifactInputSnapshotProof(actor, params.workspaceId, direct, tx));
    }
    const lineageInputs = params.lineageInputs.filter((input) => !(input.kind === "Meeting" && input.id === params.meetingId));
    if (!selfInputs.length && (Boolean(current.summaryMd?.trim()) || current.blocksJson != null || current.decisionsJson != null || (current.agendaJson != null && !params.lineageInputs.some((input) => input.kind === "MeetingAgenda" && input.id === current.id)))) {
      await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "Meeting", id: current.id }, current);
    }
    const updated = await tx.meeting.update({ where: { id: current.id }, data: {
      summaryMd: params.summaryMd, blocksJson: params.blocksJson,
      ...(!selfInputs.length ? { decisionsJson: Prisma.JsonNull } : {}),
      ...(!selfInputs.length && !params.lineageInputs.some((input) => input.kind === "MeetingAgenda" && input.id === current.id)
        ? { agendaJson: Prisma.JsonNull } : {}),
    } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Meeting", id: updated.id }, content: updated, origin: "DERIVED",
      inputs: lineageInputs, inheritedRoots,
    });
    await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId, tx);
    return { count: 1, meeting: updated };
  });
}

/** Metadata writes must keep an existing proven summary current without certifying legacy content. */
export async function preserveMeetingLineageAfterMetadataWrite(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, previous: Record<string, unknown> & { id: string }, updated: Record<string, unknown> & { id: string }) {
  await advanceHumanArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "Meeting", id: updated.id },
    before: previous, after: updated, allowSystemTransition: true });
}
