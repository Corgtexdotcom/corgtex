import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, WorkspaceBriefingPeriod, WorkspaceBriefingStatus } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import {
  type NewspaperEmailSectionId,
  type NormalizedNewspaperDigest,
} from "./newspaper-edition-rendering";

export type WorkspaceBriefingSourceType =
  | "MEETING"
  | "PROPOSAL"
  | "TENSION"
  | "ACTION"
  | "GOAL"
  | "RECOGNITION"
  | "BRAIN_ARTICLE"
  | "DOCUMENT"
  | "COMMUNICATION"
  | "BUILD_ARTIFACT"
  | "ADVICE_REQUEST"
  | "QUIET";

export type WorkspaceBriefingProminence = "lead" | "standard" | "compact" | "reference";

export type WorkspaceBriefingEditorialMode = "daily_homepage" | "daily_email" | "weekly_email";

export type WorkspaceBriefingWindow = {
  label: string;
  since: string;
  until: string;
};

export type WorkspaceBriefingSourceRef = {
  type: WorkspaceBriefingSourceType;
  id: string;
  label: string;
  href?: string | null;
};

export type WorkspaceBriefingCandidate = {
  sourceType: WorkspaceBriefingSourceType;
  sourceId: string;
  title: string;
  summaryMd: string | null;
  href: string | null;
  occurredAt: Date;
  updatedAt: Date;
  status?: string | null;
  priority?: number | null;
  dueAt?: Date | null;
  strategicScore: number;
  actionabilityScore: number;
  evidenceScore: number;
  sourceRefs: WorkspaceBriefingSourceRef[];
};

export type WorkspaceBriefingItem = {
  kind: WorkspaceBriefingSourceType;
  title: string;
  summaryMd: string;
  whyItMattersMd: string;
  prominence: WorkspaceBriefingProminence;
  sourceRefs: WorkspaceBriefingSourceRef[];
  href: string | null;
  occurredAt: string;
  status?: string | null;
  confidence: number;
};

export type NormalizedWorkspaceBriefing = {
  title: string;
  introMd: string | null;
  leadMd: string | null;
  bodyMd: string | null;
  attentionMd: string | null;
  continuingContextMd: string | null;
  closingMd: string | null;
  editorialMode: WorkspaceBriefingEditorialMode;
  freshWindow: WorkspaceBriefingWindow;
  contextWindow: WorkspaceBriefingWindow;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  generatedAt: string;
  items: WorkspaceBriefingItem[];
  sourceRefs: WorkspaceBriefingSourceRef[];
  sourceCounts: Record<string, number>;
};

const FRESH_WINDOW_DAYS: Record<WorkspaceBriefingPeriod, number> = {
  DAILY: 1.5,
  WEEKLY: 7,
};

const CONTEXT_WINDOW_DAYS: Record<WorkspaceBriefingPeriod, number> = {
  DAILY: 30,
  WEEKLY: 90,
};

const WORKSPACE_BRIEFING_SOURCE_LABELS: Record<WorkspaceBriefingSourceType, string> = {
  ACTION: "Action",
  ADVICE_REQUEST: "Advice request",
  BRAIN_ARTICLE: "Knowledge",
  BUILD_ARTIFACT: "Build",
  COMMUNICATION: "Conversation",
  DOCUMENT: "Document",
  GOAL: "Goal",
  MEETING: "Meeting",
  PROPOSAL: "Proposal",
  QUIET: "Quiet",
  RECOGNITION: "Recognition",
  TENSION: "Tension",
};

function dateKeyFromISO(dateISO: string) {
  return new Date(dateISO).toISOString().split("T")[0];
}

function latestDate(...values: Array<Date | null | undefined>) {
  const times = values
    .map((value) => value?.getTime() ?? Number.NaN)
    .filter((time) => Number.isFinite(time));
  return times.length > 0 ? new Date(Math.max(...times)) : new Date(0);
}

export function workspaceBriefingPeriodFromCadence(cadence: NewspaperCadence): WorkspaceBriefingPeriod {
  return cadence === "WEEKLY" ? "WEEKLY" : "DAILY";
}

export function workspaceBriefingSourceLabel(kind: WorkspaceBriefingSourceType | string) {
  const normalized = kind.trim().toUpperCase() as WorkspaceBriefingSourceType;
  if (WORKSPACE_BRIEFING_SOURCE_LABELS[normalized]) return WORKSPACE_BRIEFING_SOURCE_LABELS[normalized];
  return kind
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function workspacePath(workspaceId: string, path: string) {
  return `/workspaces/${workspaceId}${path}`;
}

function compactText(value: string | null | undefined, maxLength = 520) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;

  const slice = normalized.slice(0, maxLength).trimEnd();
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

function normalizeNarrativeText(value: string | null | undefined, maxLength = 1200) {
  const compacted = compactText(value, maxLength);
  if (!compacted) return null;
  return compacted
    .replace(/\s*(?:\.{3}|…)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBriefingTitle(value: string | null | undefined, fallback: string) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  const withoutEllipsis = normalized.replace(/\s*(?:\.{3}|…)\s*$/u, "").trim();
  return withoutEllipsis || fallback;
}

function periodEditorialMode(period: WorkspaceBriefingPeriod): WorkspaceBriefingEditorialMode {
  return period === "WEEKLY" ? "weekly_email" : "daily_homepage";
}

function windowFromDays(params: {
  generatedAt: Date;
  days: number;
  label: string;
}): WorkspaceBriefingWindow {
  return {
    label: params.label,
    since: new Date(params.generatedAt.getTime() - params.days * 24 * 60 * 60 * 1000).toISOString(),
    until: params.generatedAt.toISOString(),
  };
}

export function workspaceBriefingContextSince(period: WorkspaceBriefingPeriod, date: Date) {
  return new Date(date.getTime() - CONTEXT_WINDOW_DAYS[period] * 24 * 60 * 60 * 1000);
}

function sourceRef(
  workspaceId: string,
  type: WorkspaceBriefingSourceType,
  id: string,
  label: string,
  href: string | null,
): WorkspaceBriefingSourceRef {
  return {
    type,
    id,
    label,
    href: href ?? workspacePath(workspaceId, ""),
  };
}

function candidate(params: Omit<WorkspaceBriefingCandidate, "sourceRefs"> & { workspaceId: string }) {
  const title = cleanBriefingTitle(params.title, workspaceBriefingSourceLabel(params.sourceType));
  return {
    ...params,
    title,
    sourceRefs: [
      sourceRef(params.workspaceId, params.sourceType, params.sourceId, title, params.href),
    ],
  };
}

function recencyScore(candidate: WorkspaceBriefingCandidate, now: Date) {
  const ageDays = candidateAgeDays(candidate, now);
  if (ageDays <= 1) return 4;
  if (ageDays <= 3) return 3;
  if (ageDays <= 7) return 2;
  if (ageDays <= 30) return 1;
  return 0;
}

function candidateAgeDays(candidate: WorkspaceBriefingCandidate, now: Date) {
  return Math.max(0, (now.getTime() - candidate.occurredAt.getTime()) / (24 * 60 * 60 * 1000));
}

function dueScore(candidate: WorkspaceBriefingCandidate, now: Date) {
  if (!candidate.dueAt) return 0;
  const daysUntilDue = (candidate.dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (daysUntilDue < 0) return 4;
  if (daysUntilDue <= 2) return 3;
  if (daysUntilDue <= 7) return 2;
  return 1;
}

function staleOpenWorkPenalty(candidate: WorkspaceBriefingCandidate, now: Date) {
  if (candidate.status !== "OPEN") return 0;
  if (candidate.sourceType !== "PROPOSAL" && candidate.sourceType !== "TENSION") return 0;

  const ageDays = candidateAgeDays(candidate, now);
  if (ageDays <= 14) return 0;

  const priority = candidate.priority ?? 0;
  const hasUrgencyOrImportance = priority >= 3 || candidate.strategicScore >= 4 || dueScore(candidate, now) >= 2;
  if (ageDays > 45) return hasUrgencyOrImportance ? 1 : 4;
  if (ageDays > 21) return hasUrgencyOrImportance ? 1 : 3;
  return hasUrgencyOrImportance ? 0 : 2;
}

function routineGoalPenalty(candidate: WorkspaceBriefingCandidate, now: Date) {
  if (candidate.sourceType !== "GOAL") return 0;
  if (candidate.status === "AT_RISK" || candidate.status === "BEHIND") return 0;
  if (dueScore(candidate, now) >= 2) return 0;
  return candidate.summaryMd?.trim().startsWith("0% complete") ? 2 : 0;
}

function isClosedCandidateStatus(status: string | null | undefined) {
  const normalized = status?.trim().toUpperCase();
  return normalized === "RESOLVED"
    || normalized === "CLOSED"
    || normalized === "DONE"
    || normalized === "COMPLETED"
    || normalized === "CANCELED"
    || normalized === "CANCELLED"
    || normalized === "ARCHIVED"
    || normalized === "DRAFT";
}

function isResolvedCandidateStatus(status: string | null | undefined) {
  const normalized = status?.trim().toUpperCase();
  return normalized === "RESOLVED"
    || normalized === "CLOSED"
    || normalized === "DONE"
    || normalized === "COMPLETED";
}

function highSignalActionableText(candidate: WorkspaceBriefingCandidate) {
  return `${candidate.title} ${candidate.summaryMd ?? ""}`.toLowerCase();
}

function recentActionableSignalBoost(candidate: WorkspaceBriefingCandidate, now: Date) {
  if (candidate.sourceType !== "TENSION" && candidate.sourceType !== "ACTION" && candidate.sourceType !== "ADVICE_REQUEST") return 0;
  if (isClosedCandidateStatus(candidate.status)) return 0;

  const ageDays = candidateAgeDays(candidate, now);
  if (ageDays > 2) return 0;

  const text = highSignalActionableText(candidate);
  const isDecisionShaping = /\b(block|blocked|blocker|critical|urgent|risk|assumption|decision|alignment|review|stuck|waiting)\b/.test(text);
  const recentBase = ageDays <= 1 ? 3 : 2;
  return recentBase + (isDecisionShaping ? 2 : 0);
}

function recentClosureSignalBoost(candidate: WorkspaceBriefingCandidate, now: Date) {
  if (candidate.sourceType !== "TENSION" && candidate.sourceType !== "PROPOSAL" && candidate.sourceType !== "ADVICE_REQUEST") return 0;
  if (!isResolvedCandidateStatus(candidate.status)) return 0;

  const ageDays = candidateAgeDays(candidate, now);
  if (ageDays > 2) return 0;

  const text = highSignalActionableText(candidate);
  const isDecisionShaping = /\b(block|blocked|blocker|critical|urgent|risk|assumption|decision|alignment|review|resolved|resolution)\b/.test(text);
  const recentBase = ageDays <= 1 ? 2 : 1;
  return recentBase + (isDecisionShaping ? 1 : 0);
}

export function scoreWorkspaceBriefingCandidate(candidate: WorkspaceBriefingCandidate, now = new Date()) {
  const statusBoost = candidate.status === "OPEN" || candidate.status === "IN_PROGRESS" || candidate.status === "ACTIVE"
    ? 2
    : candidate.status === "AT_RISK" || candidate.status === "BEHIND"
      ? 3
      : 0;

  const score = (
    recencyScore(candidate, now)
    + dueScore(candidate, now)
    + candidate.strategicScore
    + candidate.actionabilityScore
    + candidate.evidenceScore
    + statusBoost
    + Math.min(3, Math.max(0, candidate.priority ?? 0))
    + recentActionableSignalBoost(candidate, now)
    + recentClosureSignalBoost(candidate, now)
    - staleOpenWorkPenalty(candidate, now)
    - routineGoalPenalty(candidate, now)
  );

  return Math.max(0, score);
}

export function rankWorkspaceBriefingCandidates(candidates: WorkspaceBriefingCandidate[], now = new Date()) {
  return [...candidates].sort((a, b) => (
    scoreWorkspaceBriefingCandidate(b, now) - scoreWorkspaceBriefingCandidate(a, now)
    || b.occurredAt.getTime() - a.occurredAt.getTime()
    || a.title.localeCompare(b.title)
  ));
}

function prominenceFor(score: number, index: number): WorkspaceBriefingProminence {
  if (index === 0) return score >= 8 ? "lead" : "standard";
  if (score >= 8) return "standard";
  if (score >= 4) return "compact";
  return "reference";
}

function whyCandidateMatters(candidate: WorkspaceBriefingCandidate) {
  if (candidate.sourceType === "ACTION") return candidate.dueAt ? "Timing or ownership is attached, so this is worth checking before it slips." : "This is active work that may need follow-through.";
  if (candidate.sourceType === "TENSION") return candidate.status === "OPEN" ? "It is unresolved and can affect coordination or priorities." : "It changed recently and may explain the current direction.";
  if (candidate.sourceType === "PROPOSAL") return candidate.status === "OPEN" ? "A decision, advice, or alignment may still be needed before this moves forward." : "It records a decision or operating change.";
  if (candidate.sourceType === "MEETING") return "It is operating evidence and may contain decisions or follow-ups.";
  if (candidate.sourceType === "GOAL") return "This connects today’s work to current strategic direction.";
  if (candidate.sourceType === "ADVICE_REQUEST") return candidate.status === "ACTIVE"
    ? "Someone is asking for input before work can move forward."
    : "This records input or advice that was closed recently.";
  if (candidate.sourceType === "BUILD_ARTIFACT") return "This reflects shipped or in-flight implementation work.";
  return "This is useful context for understanding the workspace right now.";
}

function itemFromCandidate(candidate: WorkspaceBriefingCandidate, index: number, now: Date): WorkspaceBriefingItem {
  const score = scoreWorkspaceBriefingCandidate(candidate, now);
  return {
    kind: candidate.sourceType,
    title: cleanBriefingTitle(candidate.title, workspaceBriefingSourceLabel(candidate.sourceType)),
    summaryMd: normalizeNarrativeText(candidate.summaryMd, index === 0 ? 1100 : 720) ?? cleanBriefingTitle(candidate.title, workspaceBriefingSourceLabel(candidate.sourceType)),
    whyItMattersMd: whyCandidateMatters(candidate),
    prominence: prominenceFor(score, index),
    sourceRefs: candidate.sourceRefs,
    href: candidate.href,
    occurredAt: candidate.occurredAt.toISOString(),
    status: candidate.status ?? null,
    confidence: Math.max(0.55, Math.min(0.98, 0.55 + score / 25)),
  };
}

function isFreshBriefingCandidate(candidate: WorkspaceBriefingCandidate, period: WorkspaceBriefingPeriod, generatedAt: Date) {
  const ageDays = Math.max(0, (generatedAt.getTime() - candidate.occurredAt.getTime()) / (24 * 60 * 60 * 1000));
  return ageDays <= FRESH_WINDOW_DAYS[period];
}

function selectBriefingCandidates(
  ranked: WorkspaceBriefingCandidate[],
  period: WorkspaceBriefingPeriod,
  generatedAt: Date,
  maxItems = 10,
) {
  if (ranked.length <= maxItems) return ranked;
  const selected = ranked.slice(0, maxItems);
  const selectedKeys = new Set(selected.map(candidateKey));
  const reservedFreshCount = Math.min(maxItems, Math.max(1, Math.ceil(maxItems * 0.25)));
  const freshCandidates = ranked
    .filter((candidate) => isFreshBriefingCandidate(candidate, period, generatedAt))
    .slice(0, reservedFreshCount);

  for (const freshCandidate of freshCandidates) {
    const freshKey = candidateKey(freshCandidate);
    if (selectedKeys.has(freshKey)) continue;
    const replaceIndex = selected
      .map((candidate, index) => ({ candidate, index }))
      .reverse()
      .find(({ candidate }) => !isFreshBriefingCandidate(candidate, period, generatedAt))?.index;
    if (replaceIndex === undefined) break;
    selectedKeys.delete(candidateKey(selected[replaceIndex]));
    selected[replaceIndex] = freshCandidate;
    selectedKeys.add(freshKey);
  }

  return selected;
}

function uniqueSourceRefs(items: WorkspaceBriefingItem[]) {
  const refs = new Map<string, WorkspaceBriefingSourceRef>();
  for (const item of items) {
    for (const ref of item.sourceRefs) {
      refs.set(`${ref.type}:${ref.id}`, ref);
    }
  }
  return [...refs.values()];
}

function normalizeSourceRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref): WorkspaceBriefingSourceRef[] => {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return [];
    const sourceRef = ref as Record<string, unknown>;
    if (typeof sourceRef.type !== "string" || typeof sourceRef.id !== "string" || typeof sourceRef.label !== "string") return [];
    return [{
      type: sourceRef.type as WorkspaceBriefingSourceType,
      id: sourceRef.id,
      label: sourceRef.label,
      href: typeof sourceRef.href === "string" ? sourceRef.href : null,
    }];
  });
}

function countSources(candidates: WorkspaceBriefingCandidate[]) {
  const counts: Record<string, number> = {};
  for (const entry of candidates) {
    counts[entry.sourceType] = (counts[entry.sourceType] ?? 0) + 1;
  }
  return counts;
}

function quietBriefingItem(date: Date): WorkspaceBriefingItem {
  return {
    kind: "QUIET",
    title: "No major operating changes found",
    summaryMd: "No new high-signal meetings, proposals, actions, tensions, shipped work, or source updates were found for this period.",
    whyItMattersMd: "The briefing is intentionally quiet instead of filling the page with low-confidence activity.",
    prominence: "lead",
    sourceRefs: [],
    href: null,
    occurredAt: date.toISOString(),
    confidence: 0.8,
  };
}

function isFreshBriefingItem(item: WorkspaceBriefingItem, period: WorkspaceBriefingPeriod, generatedAt: Date) {
  const occurredAt = new Date(item.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return false;
  const ageDays = Math.max(0, (generatedAt.getTime() - occurredAt.getTime()) / (24 * 60 * 60 * 1000));
  return ageDays <= FRESH_WINDOW_DAYS[period];
}

function isAttentionBriefingItem(item: WorkspaceBriefingItem) {
  const status = item.status?.trim().toUpperCase();
  return status === "OPEN"
    || status === "IN_PROGRESS"
    || status === "ACTIVE"
    || status === "AT_RISK"
    || status === "BEHIND";
}

function isActiveContinuingStatus(status: string | null | undefined) {
  const normalized = status?.trim().toUpperCase();
  return normalized === "OPEN"
    || normalized === "IN_PROGRESS"
    || normalized === "ACTIVE"
    || normalized === "PUBLISHED"
    || normalized === "ON_TRACK"
    || normalized === "AT_RISK"
    || normalized === "BEHIND";
}

function isContinuingBriefingItem(item: WorkspaceBriefingItem, period: WorkspaceBriefingPeriod, generatedAt: Date) {
  if (item.kind === "QUIET") return false;
  if (isFreshBriefingItem(item, period, generatedAt)) return false;
  if (isAttentionBriefingItem(item)) return true;
  if (!isActiveContinuingStatus(item.status)) return false;
  return item.kind === "GOAL"
    || item.kind === "PROPOSAL"
    || item.kind === "TENSION"
    || item.kind === "ADVICE_REQUEST";
}

function sentenceFromItem(item: WorkspaceBriefingItem, maxLength = 760) {
  const title = cleanBriefingTitle(item.title, workspaceBriefingSourceLabel(item.kind));
  const summary = normalizeNarrativeText(item.summaryMd, maxLength);
  const titleMd = `**${title}**`;
  if (!summary || summary === title) return titleMd;
  return `${titleMd}: ${summary}`;
}

function joinNarrativeParagraphs(items: WorkspaceBriefingItem[], maxItems: number, maxLength = 760) {
  return items
    .slice(0, maxItems)
    .map((item) => sentenceFromItem(item, maxLength))
    .join("\n\n")
    .trim() || null;
}

function joinAttentionItems(items: WorkspaceBriefingItem[], period: WorkspaceBriefingPeriod) {
  if (items.length === 0) return null;
  const leadLabel = period === "WEEKLY" ? "Needs attention this week" : "Needs attention today";
  const alsoLabel = period === "WEEKLY" ? "Also keep watch this week on" : "Also keep watch on";
  const details = items.slice(0, 3).map((item) => {
    const summary = normalizeNarrativeText(item.summaryMd, 260);
    if (!summary || summary === item.title) return cleanBriefingTitle(item.title, workspaceBriefingSourceLabel(item.kind));
    return `${cleanBriefingTitle(item.title, workspaceBriefingSourceLabel(item.kind))}: ${summary}`;
  });
  if (details.length === 1) {
    return `${leadLabel}: ${details[0]}`;
  }
  const [primary, ...rest] = details;
  return [
    `${leadLabel}: ${primary}`,
    `${alsoLabel} ${rest.join(". ")}`,
  ].join("\n\n");
}

function itemKey(item: WorkspaceBriefingItem) {
  const primaryRef = item.sourceRefs[0];
  return primaryRef
    ? `${primaryRef.type}:${primaryRef.id}`
    : `${item.kind}:${item.title}`;
}

function composeWorkspaceBriefingNarrative(params: {
  period: WorkspaceBriefingPeriod;
  editorialMode?: WorkspaceBriefingEditorialMode;
  generatedAt: Date;
  items: WorkspaceBriefingItem[];
  fallbackIntro?: string | null;
}) {
  const editorialMode = params.editorialMode ?? periodEditorialMode(params.period);
  const freshWindow = windowFromDays({
    generatedAt: params.generatedAt,
    days: FRESH_WINDOW_DAYS[params.period],
    label: params.period === "WEEKLY" ? "Last 7 days" : "Last 24-36 hours",
  });
  const contextWindow = windowFromDays({
    generatedAt: params.generatedAt,
    days: CONTEXT_WINDOW_DAYS[params.period],
    label: params.period === "WEEKLY" ? "Last 30-90 days" : "Current month context",
  });
  const meaningfulItems = params.items.filter((item) => item.kind !== "QUIET");
  const freshItems = meaningfulItems.filter((item) => isFreshBriefingItem(item, params.period, params.generatedAt));
  const hasFreshItems = freshItems.length > 0;
  const leadItem = hasFreshItems ? freshItems[0] ?? quietBriefingItem(params.generatedAt) : quietBriefingItem(params.generatedAt);

  const leadMd = !hasFreshItems
    ? "No major new operating signal was found for this edition. The briefing stays short and uses continuing context instead of inventing activity."
    : sentenceFromItem(leadItem, params.period === "WEEKLY" ? 980 : 860);
  const bodyCandidates = freshItems.filter((item) => item !== leadItem);
  const bodyItems = bodyCandidates.slice(0, params.period === "WEEKLY" ? 5 : 4);
  const usedKeys = new Set([
    ...(hasFreshItems ? [itemKey(leadItem)] : []),
    ...bodyItems.map(itemKey),
  ]);
  const attentionItems = meaningfulItems
    .filter((item) => isAttentionBriefingItem(item) && !usedKeys.has(itemKey(item)))
    .slice(0, 3);
  for (const item of attentionItems) usedKeys.add(itemKey(item));
  const continuingItems = meaningfulItems
    .filter((item) => isContinuingBriefingItem(item, params.period, params.generatedAt) && !usedKeys.has(itemKey(item)))
    .slice(0, params.period === "WEEKLY" ? 5 : 4);
  const bodyMd = joinNarrativeParagraphs(bodyItems, params.period === "WEEKLY" ? 5 : 4);
  const attentionMd = joinAttentionItems(attentionItems, params.period);
  const continuingContextMd = continuingItems.length > 0
    ? joinNarrativeParagraphs(continuingItems, params.period === "WEEKLY" ? 5 : 4, 560)
    : leadItem.kind === "QUIET" ? "There is no unresolved high-signal context in the evidence pool for this edition." : null;
  const narratedItems = [
    ...(hasFreshItems ? [leadItem] : []),
    ...bodyItems,
    ...attentionItems,
    ...continuingItems,
  ];
  const narratedSourceRefs = uniqueSourceRefs(narratedItems);
  const hasSourceRefs = narratedSourceRefs.length > 0;
  const closingMd = meaningfulItems.length > 0 && hasSourceRefs
    ? "The source trail below is the evidence path for this edition. Use it when you need detail, but the story above is meant to stand on its own."
    : meaningfulItems.length > 0
      ? "No source links are attached to this edition, so the story above is the complete generated briefing."
      : "No source links are attached because no high-signal workspace activity was found for this period.";
  const introMd = !hasFreshItems && meaningfulItems.length === 0 && !params.fallbackIntro
    ? params.period === "WEEKLY"
      ? "This weekly edition found no high-signal workspace activity in the evidence pool, so it stays intentionally quiet."
      : "This daily edition found no high-signal workspace activity in the evidence pool, so it stays intentionally quiet."
    : !hasFreshItems && meaningfulItems.length > 0 && !params.fallbackIntro
    ? params.period === "WEEKLY"
      ? "This weekly edition found no fresh operating signal in the last 7 days, so it keeps unresolved context that still affects current work."
      : "This daily edition found no fresh operating signal in the last 24-36 hours, so it keeps continuing context that still matters today."
    : params.fallbackIntro
    ? normalizeNarrativeText(params.fallbackIntro, 640)
    : params.period === "WEEKLY"
      ? "This weekly edition starts with the strongest operating development from the week, then keeps unresolved context that still affects current work."
      : "This daily edition starts with the strongest signal since the last briefing, then keeps context that still matters for today.";

  return {
    introMd,
    leadMd,
    bodyMd,
    attentionMd,
    continuingContextMd,
    closingMd,
    editorialMode,
    freshWindow,
    contextWindow,
    narratedSourceRefs,
  };
}

export function buildWorkspaceBriefingFromCandidates(params: {
  workspaceId: string;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  title: string;
  candidates: WorkspaceBriefingCandidate[];
  generatedAt?: Date;
  maxItems?: number;
  editorialMode?: WorkspaceBriefingEditorialMode;
}): NormalizedWorkspaceBriefing {
  const generatedAt = params.generatedAt ?? new Date();
  const ranked = rankWorkspaceBriefingCandidates(params.candidates, generatedAt);
  const selected = selectBriefingCandidates(ranked, params.period, generatedAt, params.maxItems ?? 10);
  const items = ranked.length > 0
    ? selected.map((entry, index) => itemFromCandidate(entry, index, generatedAt))
    : [quietBriefingItem(generatedAt)];
  const counts = countSources(params.candidates);
  const { narratedSourceRefs, ...narrative } = composeWorkspaceBriefingNarrative({
    period: params.period,
    editorialMode: params.editorialMode,
    generatedAt,
    items,
  });

  return {
    title: params.title,
    ...narrative,
    period: params.period,
    dateKey: params.dateKey,
    generatedAt: generatedAt.toISOString(),
    items,
    sourceRefs: narratedSourceRefs,
    sourceCounts: counts,
  };
}

function sectionKind(sectionId: NewspaperEmailSectionId): WorkspaceBriefingSourceType {
  if (sectionId === "meetingBriefs") return "MEETING";
  if (sectionId === "decisionsAndProposals" || sectionId === "keyDecisions") return "PROPOSAL";
  if (sectionId === "resolvedTensions" || sectionId === "emergingTensions") return "TENSION";
  if (sectionId === "openActions" || sectionId === "actionItems") return "ACTION";
  if (sectionId === "goalsProgress" || sectionId === "rolesAndPeople" || sectionId === "teamPulse") return "GOAL";
  if (sectionId === "adviceRequests") return "ADVICE_REQUEST";
  if (sectionId === "builtWork") return "BUILD_ARTIFACT";
  if (sectionId === "conversationHighlights") return "COMMUNICATION";
  return "BRAIN_ARTICLE";
}

function normalizeMatchText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DIGEST_MATCH_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "being",
  "current",
  "from",
  "have",
  "into",
  "more",
  "needs",
  "open",
  "still",
  "that",
  "their",
  "there",
  "this",
  "today",
  "week",
  "with",
  "work",
]);

function digestMatchStem(token: string) {
  return token
    .replace(/ies$/u, "y")
    .replace(/tion$/u, "t")
    .replace(/ing$/u, "")
    .replace(/ed$/u, "")
    .replace(/s$/u, "");
}

function digestMatchTokens(value: string | null | undefined) {
  return new Set(normalizeMatchText(value)
    .split(/\s+/)
    .map(digestMatchStem)
    .filter((token) => token.length >= 4 && !DIGEST_MATCH_STOPWORDS.has(token)));
}

function tokenOverlapScore(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.min(left.size, right.size);
}

function normalizedPhraseIncludes(value: string, phrase: string) {
  if (!value || !phrase) return false;
  return ` ${value} `.includes(` ${phrase} `);
}

function candidateProbablyMatchesDigestItem(candidate: WorkspaceBriefingCandidate, rawItem: string) {
  const candidateTokens = digestMatchTokens([
    candidate.title,
    candidate.summaryMd,
  ].filter(Boolean).join(" "));
  const itemTokens = digestMatchTokens(rawItem);
  if (candidateTokens.size < 3 || itemTokens.size < 3) return false;
  const overlapScore = tokenOverlapScore(candidateTokens, itemTokens);
  let overlap = 0;
  for (const token of itemTokens) {
    if (candidateTokens.has(token)) overlap++;
  }
  const itemCoverage = overlap / itemTokens.size;
  const candidateCoverage = overlap / candidateTokens.size;
  if (itemTokens.size <= 5) {
    return overlapScore >= 0.85 && itemCoverage >= 0.85 && candidateCoverage >= 0.65;
  }
  return overlapScore >= 0.65 && itemCoverage >= 0.65 && candidateCoverage >= 0.35;
}

function candidateMatchesDigestItem(candidate: WorkspaceBriefingCandidate, rawItem: string) {
  const normalizedItem = normalizeMatchText(rawItem);
  if (!normalizedItem) return false;

  const normalizedTitle = normalizeMatchText(candidate.title);
  if (normalizedPhraseIncludes(normalizedItem, normalizedTitle)) return true;

  const normalizedSummary = normalizeMatchText(candidate.summaryMd);
  if (normalizedSummary.length >= 32 && (
    normalizedItem.includes(normalizedSummary.slice(0, 80))
    || normalizedSummary.includes(normalizedItem.slice(0, 80))
  )) return true;

  return candidateProbablyMatchesDigestItem(candidate, rawItem);
}

function candidateSemanticallyOverlapsDigestItem(candidate: WorkspaceBriefingCandidate, rawItem: string) {
  if (candidateMatchesDigestItem(candidate, rawItem)) return true;
  const candidateTokens = digestMatchTokens([
    candidate.title,
    candidate.summaryMd,
  ].filter(Boolean).join(" "));
  const itemTokens = digestMatchTokens(rawItem);
  if (candidateTokens.size < 4 || itemTokens.size < 4) return false;
  let overlap = 0;
  for (const token of itemTokens) {
    if (candidateTokens.has(token)) overlap++;
  }
  const itemCoverage = overlap / itemTokens.size;
  const candidateCoverage = overlap / candidateTokens.size;
  return overlap >= 4 && itemCoverage >= 0.5 && candidateCoverage >= 0.35;
}

function candidateKey(candidate: Pick<WorkspaceBriefingCandidate, "sourceType" | "sourceId">) {
  return `${candidate.sourceType}:${candidate.sourceId}`;
}

function titleFromDigestItem(rawItem: string) {
  const compact = normalizeNarrativeText(rawItem, 160);
  if (!compact) return "Workspace update";
  const colonIndex = compact.indexOf(":");
  const firstSentence = compact.match(/^(.+?[.!?])(?:\s|$)/)?.[1];
  const title = colonIndex > 8 && colonIndex < 90
    ? compact.slice(0, colonIndex)
    : firstSentence && firstSentence.length <= 90
      ? firstSentence
      : "Workspace update";
  return cleanBriefingTitle(title, "Workspace update").replace(/[.!?]$/u, "");
}

function pickCandidateForSection(
  sectionId: NewspaperEmailSectionId,
  rawItem: string,
  candidates: WorkspaceBriefingCandidate[],
  used: Set<string>,
) {
  const expectedKind = sectionKind(sectionId);
  const direct = candidates.find((entry) => (
    entry.sourceType === expectedKind
    && !used.has(candidateKey(entry))
    && candidateMatchesDigestItem(entry, rawItem)
  ));
  if (direct) used.add(candidateKey(direct));
  return direct ?? null;
}

function shouldCarryUnmatchedDigestCandidate(candidate: WorkspaceBriefingCandidate, generatedAt: Date) {
  const status = (candidate.status ?? "").toUpperCase();
  const isOpenContext = ["OPEN", "IN_PROGRESS", "ACTIVE", "PUBLISHED", "ON_TRACK", "AT_RISK", "BEHIND"].includes(status);
  const isContextKind = candidate.sourceType === "GOAL"
    || candidate.sourceType === "PROPOSAL"
    || candidate.sourceType === "TENSION"
    || candidate.sourceType === "ACTION"
    || candidate.sourceType === "ADVICE_REQUEST";
  if (!isContextKind || !isOpenContext) return false;
  const score = scoreWorkspaceBriefingCandidate(candidate, generatedAt);
  return score >= 6
    || candidate.strategicScore >= 4
    || candidate.actionabilityScore >= 4
    || dueScore(candidate, generatedAt) > 0;
}

function adviceSubjectHref(workspaceId: string, subjectType: string, subjectId: string) {
  const normalized = subjectType.trim().toUpperCase();
  if (normalized === "TENSION") return workspacePath(workspaceId, `/tensions/${subjectId}`);
  if (normalized === "ACTION") return workspacePath(workspaceId, `/actions/${subjectId}`);
  return workspacePath(workspaceId, `/proposals/${subjectId}`);
}

function meetingFreshnessDate(meeting: {
  recordedAt: Date;
  updatedAt: Date;
  createdAt: Date;
  summaryPostedAt: Date | null;
  aiProcessedAt: Date | null;
}, now = new Date()) {
  if (meeting.recordedAt.getTime() <= now.getTime()) {
    return latestDate(meeting.summaryPostedAt, meeting.aiProcessedAt, meeting.updatedAt, meeting.recordedAt, meeting.createdAt);
  }
  return latestDate(meeting.summaryPostedAt, meeting.aiProcessedAt, meeting.updatedAt, meeting.createdAt);
}

export function buildWorkspaceBriefingFromDigest(params: {
  workspaceId: string;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  title: string;
  digest: NormalizedNewspaperDigest;
  candidates: WorkspaceBriefingCandidate[];
  generatedAt?: Date;
  editorialMode?: WorkspaceBriefingEditorialMode;
}): NormalizedWorkspaceBriefing {
  const generatedAt = params.generatedAt ?? new Date();
  const rankedCandidates = rankWorkspaceBriefingCandidates(params.candidates, generatedAt);
  const used = new Set<string>();
  const digestEntries = params.digest.sections.flatMap((section, sectionIndex) => (
    section.items.map((rawItem, itemIndex) => {
      const source = pickCandidateForSection(section.id, rawItem, rankedCandidates, used);
      const semanticSource = source ?? rankedCandidates.find((entry) => (
        !used.has(candidateKey(entry))
        && candidateSemanticallyOverlapsDigestItem(entry, rawItem)
      ));
      if (!source && semanticSource) used.add(candidateKey(semanticSource));
      const scoreSource = source ?? semanticSource;
      const score = source
        ? scoreWorkspaceBriefingCandidate(source, generatedAt)
        : semanticSource
          ? Math.max(4, scoreWorkspaceBriefingCandidate(semanticSource, generatedAt) - 0.5)
          : Math.max(4, 8 - itemIndex);
      return {
        digestIndex: sectionIndex * 100 + itemIndex,
        kind: source?.sourceType ?? sectionKind(section.id),
        title: source?.title ?? titleFromDigestItem(rawItem),
        rawItem,
        whyItMattersMd: scoreSource ? whyCandidateMatters(scoreSource) : "This was selected because it helps explain the current workspace picture.",
        sourceRefs: source?.sourceRefs ?? [],
        href: source?.href ?? null,
        occurredAt: scoreSource?.occurredAt ?? generatedAt,
        status: scoreSource?.status ?? null,
        confidence: scoreSource ? Math.max(0.62, Math.min(0.98, 0.6 + score / 25)) : 0.72,
        score,
      };
    })
  ));
  const carryForwardEntries = rankedCandidates
    .filter((candidate) => !used.has(candidateKey(candidate)))
    .filter((candidate) => shouldCarryUnmatchedDigestCandidate(candidate, generatedAt))
    .filter((candidate) => !digestEntries.some((entry) => candidateSemanticallyOverlapsDigestItem(candidate, entry.rawItem)))
    .slice(0, params.period === "WEEKLY" ? 6 : 4)
    .map((source, index) => {
      const score = Math.max(0, scoreWorkspaceBriefingCandidate(source, generatedAt) - 0.25);
      return {
        digestIndex: 10_000 + index,
        kind: source.sourceType,
        title: source.title,
        rawItem: source.summaryMd ?? source.title,
        whyItMattersMd: whyCandidateMatters(source),
        sourceRefs: source.sourceRefs,
        href: source.href,
        occurredAt: source.occurredAt,
        status: source.status ?? null,
        confidence: Math.max(0.62, Math.min(0.98, 0.6 + score / 25)),
        score,
      };
    });
  const items = [...digestEntries, ...carryForwardEntries]
    .sort((a, b) => (
      b.score - a.score
      || b.occurredAt.getTime() - a.occurredAt.getTime()
      || a.digestIndex - b.digestIndex
    ))
    .map((entry, itemIndex) => ({
      kind: entry.kind,
      title: cleanBriefingTitle(entry.title, workspaceBriefingSourceLabel(entry.kind)),
      summaryMd: normalizeNarrativeText(entry.rawItem, itemIndex === 0 ? 1100 : 720) ?? cleanBriefingTitle(entry.title, workspaceBriefingSourceLabel(entry.kind)),
      whyItMattersMd: entry.whyItMattersMd,
      prominence: prominenceFor(entry.score, itemIndex),
      sourceRefs: entry.sourceRefs,
      href: entry.href,
      occurredAt: entry.occurredAt.toISOString(),
      status: entry.status,
      confidence: entry.confidence,
    }) satisfies WorkspaceBriefingItem);

  if (items.length === 0) {
    return buildWorkspaceBriefingFromCandidates({
      workspaceId: params.workspaceId,
      period: params.period,
      dateKey: params.dateKey,
        title: params.title,
        candidates: params.candidates,
        generatedAt,
        editorialMode: params.editorialMode,
      });
  }
  const { narratedSourceRefs, ...narrative } = composeWorkspaceBriefingNarrative({
    period: params.period,
    editorialMode: params.editorialMode,
    generatedAt,
    items,
    fallbackIntro: params.digest.intro,
  });

  return {
    title: params.title,
    ...narrative,
    period: params.period,
    dateKey: params.dateKey,
    generatedAt: generatedAt.toISOString(),
    items,
    sourceRefs: narratedSourceRefs,
    sourceCounts: countSources(params.candidates),
  };
}

export function normalizeWorkspaceBriefingPayload(input: unknown): NormalizedWorkspaceBriefing {
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const items = Array.isArray(record.items)
    ? record.items.flatMap((item): WorkspaceBriefingItem[] => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : null;
      const summaryMd = typeof entry.summaryMd === "string" && entry.summaryMd.trim() ? entry.summaryMd.trim() : null;
      if (!title || !summaryMd) return [];
      const kind = typeof entry.kind === "string" ? entry.kind as WorkspaceBriefingSourceType : "BRAIN_ARTICLE";
      const prominence = entry.prominence === "lead" || entry.prominence === "standard" || entry.prominence === "compact" || entry.prominence === "reference"
        ? entry.prominence
        : "compact";
      const sourceRefs = normalizeSourceRefs(entry.sourceRefs);
      return [{
        kind,
        title,
        summaryMd,
        whyItMattersMd: typeof entry.whyItMattersMd === "string" && entry.whyItMattersMd.trim()
          ? entry.whyItMattersMd.trim()
          : "This item was selected for the workspace briefing.",
        prominence,
        sourceRefs,
        href: typeof entry.href === "string" ? entry.href : null,
        occurredAt: typeof entry.occurredAt === "string" ? entry.occurredAt : new Date().toISOString(),
        status: typeof entry.status === "string" ? entry.status : null,
        confidence: typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.75,
      }];
    })
    : [];
  const period = record.period === "WEEKLY" ? "WEEKLY" : "DAILY";
  const fallbackTitle = period === "WEEKLY" ? "Weekly Workspace Briefing" : "Daily Workspace Briefing";
  const generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString();
  const normalizedItems = items.length > 0 ? items : [quietBriefingItem(new Date(generatedAt))];
  const editorialMode = record.editorialMode === "daily_email" || record.editorialMode === "weekly_email" || record.editorialMode === "daily_homepage"
    ? record.editorialMode
    : periodEditorialMode(period);
  const fallbackNarrative = composeWorkspaceBriefingNarrative({
    period,
    editorialMode,
    generatedAt: new Date(generatedAt),
    items: normalizedItems,
    fallbackIntro: typeof record.introMd === "string" && record.introMd.trim() ? record.introMd.trim() : null,
  });
  const recordWindow = (value: unknown, fallback: WorkspaceBriefingWindow): WorkspaceBriefingWindow => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
    const entry = value as Record<string, unknown>;
    return {
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : fallback.label,
      since: typeof entry.since === "string" && entry.since.trim() ? entry.since.trim() : fallback.since,
      until: typeof entry.until === "string" && entry.until.trim() ? entry.until.trim() : fallback.until,
    };
  };
  const recordMd = (key: string, fallback: string | null) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  const hasRecordSourceRefs = Array.isArray(record.sourceRefs);
  const recordSourceRefs = normalizeSourceRefs(record.sourceRefs);

  return {
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : fallbackTitle,
    introMd: recordMd("introMd", fallbackNarrative.introMd),
    leadMd: recordMd("leadMd", fallbackNarrative.leadMd),
    bodyMd: recordMd("bodyMd", fallbackNarrative.bodyMd),
    attentionMd: recordMd("attentionMd", fallbackNarrative.attentionMd),
    continuingContextMd: recordMd("continuingContextMd", fallbackNarrative.continuingContextMd),
    closingMd: recordMd("closingMd", fallbackNarrative.closingMd),
    editorialMode,
    freshWindow: recordWindow(record.freshWindow, fallbackNarrative.freshWindow),
    contextWindow: recordWindow(record.contextWindow, fallbackNarrative.contextWindow),
    period,
    dateKey: typeof record.dateKey === "string" && record.dateKey.trim() ? record.dateKey.trim() : dateKeyFromISO(new Date().toISOString()),
    generatedAt,
    items: normalizedItems,
    sourceRefs: hasRecordSourceRefs ? recordSourceRefs : fallbackNarrative.narratedSourceRefs,
    sourceCounts: typeof record.sourceCounts === "object" && record.sourceCounts !== null && !Array.isArray(record.sourceCounts)
      ? Object.fromEntries(Object.entries(record.sourceCounts as Record<string, unknown>).flatMap(([key, value]) => (
        typeof value === "number" ? [[key, value]] : []
      )))
      : {},
  };
}

export function workspaceBriefingToNewspaperDigest(input: { briefingJson: unknown } | NormalizedWorkspaceBriefing): NormalizedNewspaperDigest {
  const briefing = "briefingJson" in input ? normalizeWorkspaceBriefingPayload(input.briefingJson) : input;
  const narrativeItems = [
    briefing.leadMd,
    briefing.bodyMd,
    briefing.attentionMd,
    briefing.continuingContextMd,
    briefing.closingMd,
  ].filter((item): item is string => !!item?.trim());

  return {
    intro: briefing.introMd,
    sections: narrativeItems.length > 0
      ? [{
        id: "otherUpdates",
        title: "Workspace Narrative",
        items: narrativeItems,
      }]
      : [],
  };
}

export function renderWorkspaceBriefingMarkdown(briefing: NormalizedWorkspaceBriefing) {
  const lines = [`# ${briefing.title}`];
  const sections = [
    briefing.introMd,
    briefing.leadMd,
    briefing.bodyMd,
    briefing.attentionMd,
    briefing.continuingContextMd,
    briefing.closingMd,
  ].filter((item): item is string => !!item?.trim());

  for (const section of sections) {
    lines.push("", section);
  }

  if (briefing.sourceRefs.length > 0) {
    lines.push("", "## Source trail", "");
    for (const ref of briefing.sourceRefs.slice(0, 12)) {
      lines.push(ref.href ? `- [${ref.label}](${ref.href})` : `- ${ref.label}`);
    }
  }

  return lines.join("\n").trim();
}

export async function collectWorkspaceBriefingCandidates(params: {
  workspaceId: string;
  since: Date;
  actor?: AppActor;
  now?: Date;
  until?: Date;
}): Promise<WorkspaceBriefingCandidate[]> {
  if (params.actor) {
    await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  }

  const cutoff = params.until ?? params.now ?? new Date();
  const windowRange = { gte: params.since, lte: cutoff };
  const beforeCutoff = { lte: cutoff };

  const adviceRequestSelect = {
    id: true,
    messageMd: true,
    status: true,
    deadlineAt: true,
    completedAt: true,
    createdAt: true,
    updatedAt: true,
    process: { select: { subjectType: true, subjectId: true } },
  } as const;

  const [
    meetings,
    proposals,
    tensions,
    actions,
    goals,
    recognitions,
    articles,
    documents,
    communicationSummaries,
    buildArtifacts,
    activeAdviceRequests,
    completedAdviceRequests,
  ] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: "COMPLETED",
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
        summaryMd: true,
        recordedAt: true,
        updatedAt: true,
        createdAt: true,
        summaryPostedAt: true,
        aiProcessedAt: true,
        decisionsJson: true,
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
          { status: "OPEN" },
          { createdAt: windowRange },
          { updatedAt: windowRange },
          { publishedAt: windowRange },
          { decidedAt: windowRange },
        ],
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      take: 30,
      select: { id: true, title: true, summary: true, status: true, priority: true, decisionMd: true, createdAt: true, updatedAt: true, decidedAt: true },
    }),
    prisma.tension.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { status: "OPEN" },
          { createdAt: windowRange },
          { updatedAt: windowRange },
          { resolvedAt: windowRange },
          { publishedAt: windowRange },
        ],
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      take: 30,
      select: { id: true, title: true, bodyMd: true, status: true, priority: true, urgency: true, importance: true, createdAt: true, updatedAt: true, resolvedAt: true },
    }),
    prisma.action.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { in: ["OPEN", "IN_PROGRESS"] },
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        OR: [
          { createdAt: windowRange },
          { updatedAt: windowRange },
          { publishedAt: windowRange },
        ],
      },
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }, { updatedAt: "desc" }],
      take: 40,
      select: { id: true, title: true, bodyMd: true, status: true, priority: true, dueAt: true, createdAt: true, updatedAt: true },
    }),
    prisma.goal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        createdAt: beforeCutoff,
        updatedAt: beforeCutoff,
        status: { notIn: ["DRAFT", "ABANDONED"] },
      },
      orderBy: [{ level: "asc" }, { sortOrder: "asc" }, { updatedAt: "desc" }],
      take: 20,
      select: { id: true, title: true, descriptionMd: true, status: true, progressPercent: true, targetDate: true, updatedAt: true, level: true },
    }),
    prisma.recognition.findMany({
      where: { workspaceId: params.workspaceId, createdAt: windowRange },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, title: true, storyMd: true, createdAt: true },
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
          { lastVerifiedAt: windowRange },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, slug: true, title: true, type: true, authority: true, bodyMd: true, createdAt: true, updatedAt: true, publishedAt: true },
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
      take: 20,
      select: { id: true, title: true, source: true, textContent: true, createdAt: true, updatedAt: true },
    }),
    prisma.communicationContextSummary.findMany({
      where: {
        workspaceId: params.workspaceId,
        summaryDate: windowRange,
        updatedAt: beforeCutoff,
      },
      orderBy: { summaryDate: "desc" },
      take: 20,
      select: { id: true, title: true, summaryMd: true, summaryDate: true, updatedAt: true },
    }),
    prisma.buildArtifact.findMany({
      where: {
        workspaceId: params.workspaceId,
        updatedAt: beforeCutoff,
        OR: [
          { status: "OPEN" },
          { updatedAt: windowRange },
          { mergedAt: windowRange },
          { closedAt: windowRange },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, summaryMd: true, status: true, pullRequestUrl: true, updatedAt: true, mergedAt: true, closedAt: true },
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
      select: adviceRequestSelect,
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
      select: adviceRequestSelect,
    }),
  ]);

  const adviceRequests = [...activeAdviceRequests, ...completedAdviceRequests];

  return [
    ...meetings.map((meeting) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "MEETING" as const,
      sourceId: meeting.id,
      title: meeting.title?.trim() || "Meeting recap",
      summaryMd: compactText(meeting.summaryMd, 1200),
      href: workspacePath(params.workspaceId, `/meetings/${meeting.id}`),
      occurredAt: meetingFreshnessDate(meeting, params.now),
      updatedAt: meeting.updatedAt,
      strategicScore: meeting.decisionsJson ? 3 : 2,
      actionabilityScore: meeting.summaryMd ? 1 : 0,
      evidenceScore: 3,
    })),
    ...proposals.map((proposal) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "PROPOSAL" as const,
      sourceId: proposal.id,
      title: proposal.title,
      summaryMd: compactText(proposal.decisionMd ?? proposal.summary, 900),
      href: workspacePath(params.workspaceId, `/proposals/${proposal.id}`),
      occurredAt: proposal.decidedAt ?? proposal.updatedAt ?? proposal.createdAt,
      updatedAt: proposal.updatedAt,
      status: proposal.status,
      priority: proposal.priority,
      strategicScore: proposal.status === "OPEN" ? 3 : 2,
      actionabilityScore: proposal.status === "OPEN" ? 3 : 1,
      evidenceScore: proposal.summary || proposal.decisionMd ? 2 : 1,
    })),
    ...tensions.map((tension) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "TENSION" as const,
      sourceId: tension.id,
      title: tension.title,
      summaryMd: compactText(tension.bodyMd, 900),
      href: workspacePath(params.workspaceId, `/tensions/${tension.id}`),
      occurredAt: tension.resolvedAt ?? tension.updatedAt ?? tension.createdAt,
      updatedAt: tension.updatedAt,
      status: tension.status,
      priority: Math.max(tension.priority, tension.urgency ?? 0, tension.importance ?? 0),
      strategicScore: tension.importance ?? 1,
      actionabilityScore: tension.status === "OPEN" ? 3 : 1,
      evidenceScore: tension.bodyMd ? 2 : 1,
    })),
    ...actions.map((action) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "ACTION" as const,
      sourceId: action.id,
      title: action.title,
      summaryMd: compactText(action.bodyMd, 800),
      href: workspacePath(params.workspaceId, `/actions/${action.id}`),
      occurredAt: action.updatedAt ?? action.createdAt,
      updatedAt: action.updatedAt,
      status: action.status,
      priority: action.priority,
      dueAt: action.dueAt,
      strategicScore: 1,
      actionabilityScore: action.status === "OPEN" || action.status === "IN_PROGRESS" ? 4 : 1,
      evidenceScore: action.bodyMd ? 2 : 1,
    })),
    ...goals.map((goal) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "GOAL" as const,
      sourceId: goal.id,
      title: goal.title,
      summaryMd: compactText(`${goal.progressPercent}% complete${goal.descriptionMd ? `: ${goal.descriptionMd}` : ""}`, 700),
      href: workspacePath(params.workspaceId, "/goals"),
      occurredAt: goal.updatedAt,
      updatedAt: goal.updatedAt,
      status: goal.status,
      dueAt: goal.targetDate,
      strategicScore: goal.level === "COMPANY" ? 4 : 2,
      actionabilityScore: goal.status === "AT_RISK" || goal.status === "BEHIND" ? 3 : 1,
      evidenceScore: goal.descriptionMd ? 2 : 1,
    })),
    ...recognitions.map((recognition) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "RECOGNITION" as const,
      sourceId: recognition.id,
      title: recognition.title,
      summaryMd: compactText(recognition.storyMd, 700),
      href: workspacePath(params.workspaceId, "/goals"),
      occurredAt: recognition.createdAt,
      updatedAt: recognition.createdAt,
      strategicScore: 2,
      actionabilityScore: 0,
      evidenceScore: 2,
    })),
    ...articles.map((article) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "BRAIN_ARTICLE" as const,
      sourceId: article.id,
      title: article.title,
      summaryMd: compactText(article.bodyMd, 700),
      href: workspacePath(params.workspaceId, `/brain/${article.slug}`),
      occurredAt: latestDate(article.updatedAt, article.publishedAt, article.createdAt),
      updatedAt: article.updatedAt,
      status: article.authority,
      strategicScore: article.authority === "AUTHORITATIVE" || article.authority === "REFERENCE" ? 2 : 1,
      actionabilityScore: 0,
      evidenceScore: 2,
    })),
    ...documents.map((document) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "DOCUMENT" as const,
      sourceId: document.id,
      title: document.title,
      summaryMd: compactText(document.textContent, 700) ?? `Updated ${document.source} document.`,
      href: workspacePath(params.workspaceId, "/brain"),
      occurredAt: document.updatedAt ?? document.createdAt,
      updatedAt: document.updatedAt,
      strategicScore: 1,
      actionabilityScore: 0,
      evidenceScore: document.textContent ? 2 : 1,
    })),
    ...communicationSummaries.map((summary) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "COMMUNICATION" as const,
      sourceId: summary.id,
      title: summary.title?.trim() || "Communication summary",
      summaryMd: compactText(summary.summaryMd, 900),
      href: workspacePath(params.workspaceId, "/chat"),
      occurredAt: summary.summaryDate,
      updatedAt: summary.updatedAt,
      strategicScore: 1,
      actionabilityScore: 1,
      evidenceScore: 2,
    })),
    ...buildArtifacts.map((artifact) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "BUILD_ARTIFACT" as const,
      sourceId: artifact.id,
      title: artifact.title,
      summaryMd: compactText(artifact.summaryMd, 900),
      href: artifact.pullRequestUrl ?? workspacePath(params.workspaceId, "/versions"),
      occurredAt: latestDate(artifact.updatedAt, artifact.mergedAt, artifact.closedAt),
      updatedAt: artifact.updatedAt,
      status: artifact.status,
      strategicScore: artifact.status === "MERGED" ? 3 : 2,
      actionabilityScore: artifact.status === "OPEN" ? 2 : 0,
      evidenceScore: artifact.summaryMd ? 2 : 1,
    })),
    ...adviceRequests.map((request) => candidate({
      workspaceId: params.workspaceId,
      sourceType: "ADVICE_REQUEST" as const,
      sourceId: request.id,
      title: request.status === "ACTIVE" ? "Advice request awaiting input" : "Advice request completed",
      summaryMd: compactText(request.messageMd, 700),
      href: adviceSubjectHref(params.workspaceId, request.process.subjectType, request.process.subjectId),
      occurredAt: request.completedAt ?? request.updatedAt ?? request.createdAt,
      updatedAt: request.updatedAt,
      status: request.status,
      dueAt: request.status === "ACTIVE" ? request.deadlineAt : null,
      strategicScore: 2,
      actionabilityScore: request.status === "ACTIVE" ? 4 : 1,
      evidenceScore: 2,
    })),
  ].filter((entry) => (
    entry.occurredAt.getTime() <= cutoff.getTime()
    && entry.updatedAt.getTime() <= cutoff.getTime()
  ));
}

export async function upsertWorkspaceBriefing(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  runKey: string;
  title: string;
  status?: WorkspaceBriefingStatus;
  modelUsed?: string | null;
  briefing: NormalizedWorkspaceBriefing;
  bodyMd?: string;
  sourceCounts?: unknown;
}) {
  const bodyMd = params.bodyMd ?? renderWorkspaceBriefingMarkdown(params.briefing);
  const sourceRefs = params.briefing.sourceRefs.length > 0
    ? params.briefing.sourceRefs
    : uniqueSourceRefs(params.briefing.items);

  return prisma.workspaceBriefing.upsert({
    where: {
      workspaceId_period_dateKey: {
        workspaceId: params.workspaceId,
        period: params.period,
        dateKey: params.dateKey,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      period: params.period,
      dateKey: params.dateKey,
      runKey: params.runKey,
      title: params.title,
      status: params.status ?? "GENERATED",
      modelUsed: params.modelUsed ?? null,
      introMd: params.briefing.introMd,
      bodyMd,
      briefingJson: toInputJson(params.briefing),
      sourceRefsJson: toInputJson(sourceRefs),
      sourceCounts: toInputJson(params.sourceCounts ?? params.briefing.sourceCounts),
      generatedAt: new Date(params.briefing.generatedAt),
    },
    update: {
      workflowJobId: params.workflowJobId ?? null,
      runKey: params.runKey,
      title: params.title,
      status: params.status ?? "GENERATED",
      modelUsed: params.modelUsed ?? null,
      introMd: params.briefing.introMd,
      bodyMd,
      briefingJson: toInputJson(params.briefing),
      sourceRefsJson: toInputJson(sourceRefs),
      sourceCounts: toInputJson(params.sourceCounts ?? params.briefing.sourceCounts),
      generatedAt: new Date(params.briefing.generatedAt),
    },
  });
}

export async function getLatestWorkspaceBriefing(params: {
  workspaceId: string;
  period?: WorkspaceBriefingPeriod;
  actor?: AppActor;
}) {
  if (params.actor) {
    await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  }

  return prisma.workspaceBriefing.findFirst({
    where: {
      workspaceId: params.workspaceId,
      status: "GENERATED",
      ...(params.period ? { period: params.period } : {}),
    },
    orderBy: { generatedAt: "desc" },
    select: {
      id: true,
      workflowJobId: true,
      period: true,
      dateKey: true,
      runKey: true,
      title: true,
      status: true,
      modelUsed: true,
      introMd: true,
      bodyMd: true,
      briefingJson: true,
      sourceRefsJson: true,
      sourceCounts: true,
      generatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function generateWorkspaceBriefing(params: {
  workspaceId: string;
  period: WorkspaceBriefingPeriod;
  dateISO: string;
  workflowJobId?: string | null;
  agentRunId?: string | null;
  model?: string | null;
  editorialMode?: WorkspaceBriefingEditorialMode;
}) {
  const date = new Date(params.dateISO);
  const since = workspaceBriefingContextSince(params.period, date);
  const dateKey = dateKeyFromISO(params.dateISO);
  const title = `${params.period === "WEEKLY" ? "Weekly" : "Daily"} Workspace Briefing - ${dateKey}`;
  const runKey = params.workflowJobId ?? `${params.workspaceId}:${params.period.toLowerCase()}-workspace-briefing:${dateKey}`;
  const candidates = await collectWorkspaceBriefingCandidates({
    workspaceId: params.workspaceId,
    since,
    now: date,
    until: date,
  });
  const briefing = buildWorkspaceBriefingFromCandidates({
    workspaceId: params.workspaceId,
    period: params.period,
    dateKey,
    title,
    candidates,
    generatedAt: date,
    editorialMode: params.editorialMode,
  });

  return upsertWorkspaceBriefing({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId ?? null,
    period: params.period,
    dateKey,
    runKey,
    title,
    modelUsed: params.model ?? null,
    briefing,
  });
}
