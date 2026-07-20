import { createHash } from "node:crypto";
import { prisma } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

export type DuplicateGuardEntityType =
  | "Action"
  | "Tension"
  | "Proposal"
  | "Goal"
  | "Document"
  | "BrainSource"
  | "BrainArticle"
  | "Meeting";

export type DuplicateGuardResolution = "use_existing" | "update_existing" | "create_new";

export type DuplicateGuardOptions = {
  resolution?: DuplicateGuardResolution | null;
  targetEntityId?: string | null;
  candidateLimit?: number | null;
  onExact?: "confirm" | "use_existing";
};

export type DuplicateGuardCandidate = {
  entityType: DuplicateGuardEntityType;
  entityId: string;
  title: string | null;
  excerpt: string | null;
  score: number;
  matchKind: "exact" | "likely";
  reasons: string[];
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
};

export type DuplicateGuardInput = {
  workspaceId: string;
  entityType: DuplicateGuardEntityType;
  title?: string | null;
  body?: string | null;
  content?: string | null;
  source?: string | null;
  externalId?: string | null;
  sourceUrl?: string | null;
  contentHash?: string | null;
  calendarExternalId?: string | null;
  meetingUrlHash?: string | null;
  recordedAt?: Date | null;
  participantEmails?: string[] | null;
  assigneeMemberId?: string | null;
  raisedByMemberId?: string | null;
  ownerMemberId?: string | null;
  dueAt?: Date | null;
  targetDate?: Date | null;
  startDate?: Date | null;
  proposalId?: string | null;
  meetingId?: string | null;
  circleId?: string | null;
  parentGoalId?: string | null;
  cadence?: string | null;
  level?: string | null;
  sourceType?: string | null;
  slug?: string | null;
  articleType?: string | null;
  sourceIds?: string[] | null;
  actorUserId?: string | null;
  membershipId?: string | null;
  includePrivate?: boolean | null;
};

export type DuplicateGuardDecision = {
  resolution: DuplicateGuardResolution;
  match: DuplicateGuardCandidate;
};

type LoadedCandidate = DuplicateGuardCandidate & {
  normalizedTitle: string;
  normalizedBody: string;
  contentHash: string | null;
  exactKeys: Record<string, string | null>;
  context: Record<string, unknown>;
};

const DEFAULT_CANDIDATE_LIMIT = 50;
const MIN_CANDIDATE_LIMIT = 10;
const MAX_CANDIDATE_LIMIT = 200;
const LIKELY_MATCH_THRESHOLD = 0.78;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export class DuplicateGuardMatchError extends AppError {
  candidate: DuplicateGuardCandidate;
  recommendedResolution: DuplicateGuardResolution;
  allowedResolutions: DuplicateGuardResolution[];

  constructor(candidate: DuplicateGuardCandidate, recommendedResolution: DuplicateGuardResolution = "use_existing") {
    super(409, "DUPLICATE_GUARD_MATCH", "A similar item already exists in this workspace.");
    this.candidate = candidate;
    this.recommendedResolution = recommendedResolution;
    this.allowedResolutions = candidate.archivedAt
      ? ["create_new"]
      : ["use_existing", "update_existing", "create_new"];
  }
}

export function isDuplicateGuardMatchError(error: unknown): error is DuplicateGuardMatchError {
  return error instanceof DuplicateGuardMatchError
    || (
      error instanceof AppError
      && error.code === "DUPLICATE_GUARD_MATCH"
      && typeof (error as Partial<DuplicateGuardMatchError>).candidate === "object"
    );
}

export function duplicateGuardErrorPayload(error: DuplicateGuardMatchError) {
  return {
    status: "duplicate_confirmation_required" as const,
    candidate: error.candidate,
    recommendedResolution: error.recommendedResolution,
    allowedResolutions: error.allowedResolutions,
  };
}

export function normalizeDuplicateGuardText(value?: string | null) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(revised|revision|updated|updates|updating)\b/g, " update ")
    .replace(/\b(sent|sending|sends)\b/g, " send ")
    .replace(/\b(created|creates|creating)\b/g, " create ")
    .replace(/\b(uploaded|uploads|uploading)\b/g, " upload ")
    .replace(/\s+/g, " ")
    .trim();
}

export function duplicateGuardContentHash(value?: string | null) {
  const normalized = normalizeDuplicateGuardText(value);
  return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

export function duplicateGuardMergeText(existing?: string | null, incoming?: string | null) {
  const current = existing?.trim() ?? "";
  const next = incoming?.trim() ?? "";
  if (!next) return current || null;
  if (!current) return next;

  const normalizedCurrent = normalizeDuplicateGuardText(current);
  const normalizedNext = normalizeDuplicateGuardText(next);
  if (normalizedCurrent === normalizedNext || normalizedCurrent.includes(normalizedNext)) return current;
  if (normalizedNext.includes(normalizedCurrent)) return next;
  return `${current}\n\n---\nAdditional duplicate upload context:\n${next}`;
}

function candidateLimit(value?: number | null) {
  const input = Number(value ?? DEFAULT_CANDIDATE_LIMIT);
  const finite = Number.isFinite(input) ? Math.round(input) : DEFAULT_CANDIDATE_LIMIT;
  return Math.min(MAX_CANDIDATE_LIMIT, Math.max(MIN_CANDIDATE_LIMIT, finite));
}

function tokens(value: string) {
  return value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokenSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 12) {
    return 0.94;
  }

  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = overlap / union;
  const containment = overlap / Math.min(leftTokens.size, rightTokens.size);
  return Number(Math.max(jaccard, (jaccard * 0.55) + (containment * 0.45)).toFixed(3));
}

function sameDay(left?: Date | null, right?: unknown) {
  if (!(left instanceof Date) || Number.isNaN(left.valueOf()) || !(right instanceof Date) || Number.isNaN(right.valueOf())) return false;
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

function withinHours(left?: Date | null, right?: unknown, hours = 4) {
  if (!(left instanceof Date) || Number.isNaN(left.valueOf()) || !(right instanceof Date) || Number.isNaN(right.valueOf())) return false;
  return Math.abs(left.getTime() - right.getTime()) <= hours * 60 * 60 * 1000;
}

function arrayOverlap(left?: string[] | null, right?: unknown) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  const normalizedLeft = left.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalizedRight = right.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return 0;
  const rightSet = new Set(normalizedRight);
  const count = normalizedLeft.filter((value) => rightSet.has(value)).length;
  return count / Math.min(normalizedLeft.length, normalizedRight.length);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceUrlFromMetadata(metadata: unknown) {
  const data = jsonObject(metadata);
  return readString(data.sourceUrl) ?? readString(data.url) ?? readString(data.externalUrl);
}

function iso(value: unknown) {
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString() : null;
}

function excerpt(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.replace(/\s+/g, " ").slice(0, 240) : null;
}

function toLoadedCandidate(params: {
  entityType: DuplicateGuardEntityType;
  entityId: string;
  title?: string | null;
  body?: string | null;
  content?: string | null;
  contentHash?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  archivedAt?: unknown;
  exactKeys?: Record<string, string | null>;
  context?: Record<string, unknown>;
}): LoadedCandidate {
  const textBody = params.body ?? params.content ?? null;
  return {
    entityType: params.entityType,
    entityId: params.entityId,
    title: params.title ?? null,
    excerpt: excerpt(textBody),
    score: 0,
    matchKind: "likely",
    reasons: [],
    createdAt: iso(params.createdAt),
    updatedAt: iso(params.updatedAt),
    archivedAt: iso(params.archivedAt),
    normalizedTitle: normalizeDuplicateGuardText(params.title),
    normalizedBody: normalizeDuplicateGuardText(textBody),
    contentHash: params.contentHash ?? duplicateGuardContentHash(textBody),
    exactKeys: params.exactKeys ?? {},
    context: params.context ?? {},
  };
}

async function latestRows(entityType: DuplicateGuardEntityType, workspaceId: string, limit: number, input: DuplicateGuardInput) {
  const db = prisma as any;
  const privateWorkItemVisibility = input.includePrivate
    ? {}
    : {
      OR: [
        { isPrivate: false },
        ...(input.actorUserId ? [{ isPrivate: true, authorUserId: input.actorUserId }] : []),
      ],
    };
  const privateArticleVisibility = input.includePrivate
    ? {}
    : {
      OR: [
        { isPrivate: false },
        ...(input.membershipId ? [{ isPrivate: true, ownerMemberId: input.membershipId }] : []),
      ],
    };
  switch (entityType) {
    case "Action":
      return await db.action?.findMany?.({
        where: { workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] }, ...privateWorkItemVisibility },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
    case "Tension":
      return await db.tension?.findMany?.({
        where: { workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN"] }, ...privateWorkItemVisibility },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
    case "Proposal":
      return await db.proposal?.findMany?.({
        where: { workspaceId, archivedAt: null, status: { in: ["DRAFT", "OPEN"] }, ...privateWorkItemVisibility },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
    case "Goal":
      return await db.goal?.findMany?.({
        where: { workspaceId, archivedAt: null, status: { in: ["DRAFT", "ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] } },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
    case "Document": {
      const rows = await db.document?.findMany?.({
        where: { workspaceId, archivedAt: null },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
      const inputContentHash = input.contentHash ?? duplicateGuardContentHash(input.content ?? input.body);
      const exactClauses = [
        input.sourceUrl ? { metadata: { path: ["sourceUrl"], equals: input.sourceUrl } } : null,
        input.sourceUrl ? { metadata: { path: ["url"], equals: input.sourceUrl } } : null,
        input.sourceUrl ? { metadata: { path: ["externalUrl"], equals: input.sourceUrl } } : null,
        inputContentHash ? { metadata: { path: ["contentHash"], equals: inputContentHash } } : null,
      ].filter(Boolean);
      if (exactClauses.length === 0) return rows;
      const exactRows = await db.document?.findMany?.({
        where: { workspaceId, OR: exactClauses },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: 5,
      }) ?? [];
      return [...exactRows, ...rows];
    }
    case "BrainSource": {
      const rows = await db.brainSource?.findMany?.({
        where: { workspaceId, archivedAt: null },
        orderBy: { createdAt: "desc" },
        take: limit,
      }) ?? [];
      if (!input.externalId) return rows;
      const exactRows = await db.brainSource?.findMany?.({
        where: { workspaceId, externalId: input.externalId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }) ?? [];
      return [...exactRows, ...rows];
    }
    case "BrainArticle": {
      const rows = await db.brainArticle?.findMany?.({
        where: { workspaceId, archivedAt: null, ...privateArticleVisibility },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
      if (!input.slug) return rows;
      const exactRows = await db.brainArticle?.findMany?.({
        where: { workspaceId, slug: input.slug, ...privateArticleVisibility },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: 5,
      }) ?? [];
      return [...exactRows, ...rows];
    }
    case "Meeting": {
      const rows = await db.meeting?.findMany?.({
        where: { workspaceId, archivedAt: null },
        orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
        take: limit,
      }) ?? [];
      const exactClauses = [
        input.externalId ? { externalId: input.externalId } : null,
        input.calendarExternalId ? { calendarExternalId: input.calendarExternalId } : null,
        input.meetingUrlHash ? { meetingUrlHash: input.meetingUrlHash } : null,
      ].filter(Boolean);
      if (exactClauses.length === 0) return rows;
      const exactRows = await db.meeting?.findMany?.({
        where: { workspaceId, OR: exactClauses },
        orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
        take: 5,
      }) ?? [];
      return [...exactRows, ...rows];
    }
  }
}

function mapRows(entityType: DuplicateGuardEntityType, rows: any[]): LoadedCandidate[] {
  const byId = new Map<string, LoadedCandidate>();
  for (const row of rows) {
    if (!row?.id || byId.has(row.id)) continue;

    let candidate: LoadedCandidate;
    if (entityType === "Document") {
      candidate = toLoadedCandidate({
        entityType,
        entityId: row.id,
        title: row.title,
        body: row.textContent,
        contentHash: readString(jsonObject(row.metadata).contentHash),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        exactKeys: {
          sourceUrl: sourceUrlFromMetadata(row.metadata),
          storageKey: readString(row.storageKey),
        },
        context: {
          source: row.source,
          mimeType: row.mimeType,
        },
      });
    } else if (entityType === "BrainSource") {
      candidate = toLoadedCandidate({
        entityType,
        entityId: row.id,
        title: row.title,
        body: row.content,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        exactKeys: {
          externalId: readString(row.externalId),
          sourceUrl: sourceUrlFromMetadata(row.metadata),
        },
        context: {
          sourceType: row.sourceType,
          channel: row.channel,
        },
      });
    } else if (entityType === "BrainArticle") {
      candidate = toLoadedCandidate({
        entityType,
        entityId: row.id,
        title: row.title,
        body: row.bodyMd,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        exactKeys: {
          slug: readString(row.slug),
        },
        context: {
          articleType: row.type,
          authority: row.authority,
          ownerMemberId: row.ownerMemberId,
          sourceIds: row.sourceIds,
        },
      });
    } else if (entityType === "Meeting") {
      candidate = toLoadedCandidate({
        entityType,
        entityId: row.id,
        title: row.title,
        body: row.transcript ?? row.summaryMd,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        exactKeys: {
          externalId: readString(row.externalId),
          calendarExternalId: readString(row.calendarExternalId),
          meetingUrlHash: readString(row.meetingUrlHash),
        },
        context: {
          source: row.source,
          recordedAt: row.recordedAt,
          participantEmails: row.participantEmails,
        },
      });
    } else {
      candidate = toLoadedCandidate({
        entityType,
        entityId: row.id,
        title: row.title,
        body: row.bodyMd ?? row.descriptionMd ?? row.summary,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        context: {
          assigneeMemberId: row.assigneeMemberId,
          raisedByMemberId: row.raisedByMemberId,
          ownerMemberId: row.ownerMemberId,
          dueAt: row.dueAt,
          proposalId: row.proposalId,
          meetingId: row.meetingId,
          circleId: row.circleId,
          parentGoalId: row.parentGoalId,
          cadence: row.cadence,
          level: row.level,
          targetDate: row.targetDate,
          startDate: row.startDate,
        },
      });
    }
    byId.set(row.id, candidate);
  }
  return [...byId.values()];
}

function exactMatchReasons(input: DuplicateGuardInput, candidate: LoadedCandidate) {
  const reasons: string[] = [];
  const inputContentHash = input.contentHash ?? duplicateGuardContentHash(input.content ?? input.body);
  const inputExactKeys: Record<string, string | null | undefined> = {
    externalId: input.externalId,
    sourceUrl: input.sourceUrl,
    contentHash: inputContentHash,
    calendarExternalId: input.calendarExternalId,
    meetingUrlHash: input.meetingUrlHash,
    slug: input.slug,
  };

  for (const [key, inputValue] of Object.entries(inputExactKeys)) {
    const candidateValue = key === "contentHash" ? candidate.contentHash : candidate.exactKeys[key];
    if (inputValue && candidateValue && inputValue === candidateValue) {
      reasons.push(key);
    }
  }

  const normalizedTitle = normalizeDuplicateGuardText(input.title);
  const normalizedBody = normalizeDuplicateGuardText(input.body ?? input.content);
  if (normalizedTitle && normalizedTitle === candidate.normalizedTitle && normalizedBody && normalizedBody === candidate.normalizedBody) {
    reasons.push("identical title and content");
  } else if (normalizedTitle && normalizedTitle === candidate.normalizedTitle && !normalizedBody && !candidate.normalizedBody) {
    reasons.push("identical title");
  }
  return reasons;
}

function contextScore(input: DuplicateGuardInput, candidate: LoadedCandidate) {
  const reasons: string[] = [];
  let score = 0;

  const pairs: Array<[keyof DuplicateGuardInput, string, number]> = [
    ["source", "same source", 0.04],
    ["assigneeMemberId", "same assignee", 0.1],
    ["raisedByMemberId", "same raised-by member", 0.08],
    ["ownerMemberId", "same owner", 0.08],
    ["proposalId", "same proposal", 0.1],
    ["meetingId", "same meeting", 0.12],
    ["circleId", "same circle", 0.06],
    ["parentGoalId", "same parent goal", 0.08],
    ["cadence", "same cadence", 0.05],
    ["level", "same level", 0.05],
    ["sourceType", "same source type", 0.05],
    ["articleType", "same article type", 0.05],
  ];

  for (const [key, reason, weight] of pairs) {
    const inputValue = input[key];
    const candidateValue = candidate.context[key === "source" ? "source" : key];
    if (typeof inputValue === "string" && inputValue && inputValue === candidateValue) {
      score += weight;
      reasons.push(reason);
    }
  }

  if (sameDay(input.dueAt, candidate.context.dueAt)) {
    score += 0.08;
    reasons.push("same due date");
  }
  if (withinHours(input.recordedAt, candidate.context.recordedAt)) {
    score += 0.12;
    reasons.push("nearby recorded time");
  }
  if (sameDay(input.targetDate, candidate.context.targetDate)) {
    score += 0.06;
    reasons.push("same target date");
  }
  if (sameDay(input.startDate, candidate.context.startDate)) {
    score += 0.04;
    reasons.push("same start date");
  }

  const participantOverlap = arrayOverlap(input.participantEmails, candidate.context.participantEmails);
  if (participantOverlap > 0) {
    score += 0.12 * participantOverlap;
    reasons.push("participant overlap");
  }

  const sourceIdsOverlap = arrayOverlap(input.sourceIds, candidate.context.sourceIds);
  if (sourceIdsOverlap > 0) {
    score += 0.1 * sourceIdsOverlap;
    reasons.push("source overlap");
  }

  return { score: Math.min(0.28, score), reasons };
}

function scoreCandidate(input: DuplicateGuardInput, candidate: LoadedCandidate): DuplicateGuardCandidate | null {
  const exactReasons = exactMatchReasons(input, candidate);
  if (exactReasons.length > 0) {
    return {
      score: 1,
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      title: candidate.title,
      excerpt: candidate.excerpt,
      matchKind: "exact",
      reasons: exactReasons,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      archivedAt: candidate.archivedAt,
    };
  }

  const inputTitle = normalizeDuplicateGuardText(input.title);
  const inputBody = normalizeDuplicateGuardText(input.body ?? input.content);
  const titleScore = tokenSimilarity(inputTitle, candidate.normalizedTitle);
  const bodyScore = tokenSimilarity(inputBody, candidate.normalizedBody);
  const textScore = inputBody || candidate.normalizedBody
    ? Math.max((titleScore * 0.68) + (bodyScore * 0.32), titleScore * 0.92, bodyScore * 0.78)
    : titleScore;
  const context = contextScore(input, candidate);
  const score = Number(Math.min(1, textScore + context.score).toFixed(3));
  if (score < LIKELY_MATCH_THRESHOLD) return null;

  const reasons = [
    titleScore >= 0.72 ? "similar title" : null,
    bodyScore >= 0.72 ? "similar content" : null,
    ...context.reasons,
  ].filter((value): value is string => Boolean(value));

  return {
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    title: candidate.title,
    excerpt: candidate.excerpt,
    score,
    matchKind: "likely",
    reasons: reasons.length > 0 ? reasons : ["similar text"],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    archivedAt: candidate.archivedAt,
  };
}

function cleanCandidate(candidate: DuplicateGuardCandidate): DuplicateGuardCandidate {
  return {
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    title: candidate.title,
    excerpt: candidate.excerpt,
    score: candidate.score,
    matchKind: candidate.matchKind,
    reasons: candidate.reasons,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    archivedAt: candidate.archivedAt,
  };
}

async function findDuplicateGuardMatch(input: DuplicateGuardInput, options?: DuplicateGuardOptions | null) {
  const rows = await latestRows(input.entityType, input.workspaceId, candidateLimit(options?.candidateLimit), input);
  const candidates = mapRows(input.entityType, rows);
  const matches = candidates
    .map((candidate) => scoreCandidate(input, candidate))
    .filter((candidate): candidate is DuplicateGuardCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score);
  return matches.map(cleanCandidate);
}

export async function checkWorkspaceDuplicateGuard(input: DuplicateGuardInput, options?: DuplicateGuardOptions | null): Promise<DuplicateGuardDecision | null> {
  const resolution = options?.resolution ?? null;
  if (resolution === "create_new") {
    const [match] = await findDuplicateGuardMatch(input, options);
    return match ? { resolution, match } : null;
  }

  const matches = await findDuplicateGuardMatch(input, options);
  const match = options?.targetEntityId
    ? matches.find((candidate) => candidate.entityId === options.targetEntityId)
    : matches[0] ?? null;

  if (resolution) {
    invariant(match, 400, "DUPLICATE_GUARD_TARGET_NOT_FOUND", "Duplicate target no longer matches the new item.");
    invariant(!match.archivedAt, 400, "DUPLICATE_GUARD_TARGET_ARCHIVED", "Archived duplicate targets can only be acknowledged by creating a new item.");
    return { resolution, match };
  }

  if (!match) return null;
  if (match.archivedAt) {
    throw new DuplicateGuardMatchError(match, "create_new");
  }
  if (match.matchKind === "exact" && options?.onExact === "use_existing") {
    return { resolution: "use_existing", match };
  }

  throw new DuplicateGuardMatchError(match, match.matchKind === "exact" ? "use_existing" : "update_existing");
}

export function duplicateGuardAuditMeta(decision: DuplicateGuardDecision | null) {
  if (!decision || decision.resolution !== "create_new") return {};
  return {
    duplicateGuardOverride: {
      candidateEntityType: decision.match.entityType,
      candidateEntityId: decision.match.entityId,
      score: decision.match.score,
      matchKind: decision.match.matchKind,
      reasons: decision.match.reasons,
    },
  };
}
