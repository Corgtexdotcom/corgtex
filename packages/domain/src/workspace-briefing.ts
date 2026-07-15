import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, WorkspaceBriefingPeriod, WorkspaceBriefingStatus } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import {
  capNewspaperDigestSections,
  renderNewspaperDigestMarkdown,
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
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  generatedAt: string;
  items: WorkspaceBriefingItem[];
  sourceRefs: WorkspaceBriefingSourceRef[];
  sourceCounts: Record<string, number>;
};

const PERIOD_LOOKBACK_DAYS: Record<WorkspaceBriefingPeriod, number> = {
  DAILY: 1,
  WEEKLY: 7,
};

const KIND_TO_SECTION: Record<WorkspaceBriefingSourceType, NewspaperEmailSectionId> = {
  MEETING: "meetingBriefs",
  PROPOSAL: "decisionsAndProposals",
  TENSION: "emergingTensions",
  ACTION: "openActions",
  GOAL: "goalsProgress",
  RECOGNITION: "goalsProgress",
  BRAIN_ARTICLE: "otherUpdates",
  DOCUMENT: "otherUpdates",
  COMMUNICATION: "conversationHighlights",
  BUILD_ARTIFACT: "builtWork",
  ADVICE_REQUEST: "adviceRequests",
  QUIET: "otherUpdates",
};

const SECTION_TITLES: Record<NewspaperEmailSectionId, string> = {
  adviceRequests: "Requests Awaiting Your Input",
  meetingBriefs: "Meeting Briefs",
  decisionsAndProposals: "Decisions & Proposals",
  resolvedTensions: "Resolved Tensions",
  openActions: "Open Actions",
  goalsProgress: "Goals & Quarterly Progress",
  rolesAndPeople: "Roles & People",
  keyDecisions: "Key Decisions Made",
  actionItems: "Action Items Identified",
  builtWork: "Built / Shipped Work",
  conversationHighlights: "Conversation Highlights",
  teamPulse: "Team Pulse",
  emergingTensions: "Emerging Tensions",
  otherUpdates: "Other Updates",
};

function sectionForBriefingItem(item: WorkspaceBriefingItem): NewspaperEmailSectionId {
  if (item.kind === "ADVICE_REQUEST" && item.status && item.status !== "ACTIVE") return "otherUpdates";
  return KIND_TO_SECTION[item.kind] ?? "otherUpdates";
}

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

const WORKSPACE_BRIEFING_SOURCE_INTRO_LABELS: Record<WorkspaceBriefingSourceType, string> = {
  ACTION: "open actions",
  ADVICE_REQUEST: "advice requests",
  BRAIN_ARTICLE: "knowledge updates",
  BUILD_ARTIFACT: "shipped or in-flight work",
  COMMUNICATION: "workspace conversations",
  DOCUMENT: "document updates",
  GOAL: "strategic goals",
  MEETING: "recent meetings",
  PROPOSAL: "open proposals",
  QUIET: "quiet context",
  RECOGNITION: "recognition",
  TENSION: "active tensions",
};

function dateKeyFromISO(dateISO: string) {
  return new Date(dateISO).toISOString().split("T")[0];
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
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
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
  return {
    ...params,
    sourceRefs: [
      sourceRef(params.workspaceId, params.sourceType, params.sourceId, params.title, params.href),
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
  if (candidate.sourceType === "TENSION") return candidate.status === "OPEN" ? "This is unresolved and can affect coordination or priorities." : "This changed recently and may explain the current direction.";
  if (candidate.sourceType === "PROPOSAL") return candidate.status === "OPEN" ? "A decision, advice, or alignment may still be needed before this moves forward." : "This records a decision or operating change.";
  if (candidate.sourceType === "MEETING") return "This is recent operating evidence and may contain decisions or follow-ups.";
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
    title: candidate.title,
    summaryMd: compactText(candidate.summaryMd, index === 0 ? 900 : 560) ?? candidate.title,
    whyItMattersMd: whyCandidateMatters(candidate),
    prominence: prominenceFor(score, index),
    sourceRefs: candidate.sourceRefs,
    href: candidate.href,
    occurredAt: candidate.occurredAt.toISOString(),
    status: candidate.status ?? null,
    confidence: Math.max(0.55, Math.min(0.98, 0.55 + score / 25)),
  };
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

function countSources(candidates: WorkspaceBriefingCandidate[]) {
  const counts: Record<string, number> = {};
  for (const entry of candidates) {
    counts[entry.sourceType] = (counts[entry.sourceType] ?? 0) + 1;
  }
  return counts;
}

function formatIntroList(labels: string[]) {
  if (labels.length === 0) return null;
  if (labels.length === 1) return `Today centers on ${labels[0]}.`;
  if (labels.length === 2) return `Today is mostly about ${labels[0]} and ${labels[1]}.`;
  return `Today is mostly about ${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}.`;
}

function workspaceBriefingIntro(items: WorkspaceBriefingItem[]) {
  const counts = new Map<WorkspaceBriefingSourceType, { count: number; firstIndex: number }>();
  for (const [index, item] of items.entries()) {
    if (item.kind === "QUIET") continue;
    const current = counts.get(item.kind);
    counts.set(item.kind, {
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  }

  const labels = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex)
    .slice(0, 3)
    .map(([kind]) => WORKSPACE_BRIEFING_SOURCE_INTRO_LABELS[kind] ?? workspaceBriefingSourceLabel(kind).toLowerCase());

  return formatIntroList(labels);
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

export function buildWorkspaceBriefingFromCandidates(params: {
  workspaceId: string;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  title: string;
  candidates: WorkspaceBriefingCandidate[];
  generatedAt?: Date;
  maxItems?: number;
}): NormalizedWorkspaceBriefing {
  const generatedAt = params.generatedAt ?? new Date();
  const ranked = rankWorkspaceBriefingCandidates(params.candidates, generatedAt);
  const items = ranked.length > 0
    ? ranked.slice(0, params.maxItems ?? 10).map((entry, index) => itemFromCandidate(entry, index, generatedAt))
    : [quietBriefingItem(generatedAt)];
  const counts = countSources(params.candidates);
  const sourceKinds = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind.toLowerCase().replace(/_/g, " ")}`)
    .slice(0, 5)
    .join(", ");

  return {
    title: params.title,
    introMd: sourceKinds
      ? workspaceBriefingIntro(items)
      : "This was a quiet period. The briefing stays short because no major new operating signals were found.",
    period: params.period,
    dateKey: params.dateKey,
    generatedAt: generatedAt.toISOString(),
    items,
    sourceRefs: uniqueSourceRefs(items),
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

function candidateMatchesDigestItem(candidate: WorkspaceBriefingCandidate, rawItem: string) {
  const normalizedItem = normalizeMatchText(rawItem);
  if (!normalizedItem) return false;

  const normalizedTitle = normalizeMatchText(candidate.title);
  if (normalizedTitle && normalizedItem.includes(normalizedTitle)) return true;

  const normalizedSummary = normalizeMatchText(candidate.summaryMd);
  return normalizedSummary.length >= 32 && (
    normalizedItem.includes(normalizedSummary.slice(0, 80))
    || normalizedSummary.includes(normalizedItem.slice(0, 80))
  );
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
    && !used.has(`${entry.sourceType}:${entry.sourceId}`)
    && candidateMatchesDigestItem(entry, rawItem)
  ));
  if (direct) used.add(`${direct.sourceType}:${direct.sourceId}`);
  return direct ?? null;
}

function adviceSubjectHref(workspaceId: string, subjectType: string, subjectId: string) {
  const normalized = subjectType.trim().toUpperCase();
  if (normalized === "TENSION") return workspacePath(workspaceId, `/tensions/${subjectId}`);
  if (normalized === "ACTION") return workspacePath(workspaceId, `/actions/${subjectId}`);
  return workspacePath(workspaceId, `/proposals/${subjectId}`);
}

export function buildWorkspaceBriefingFromDigest(params: {
  workspaceId: string;
  period: WorkspaceBriefingPeriod;
  dateKey: string;
  title: string;
  digest: NormalizedNewspaperDigest;
  candidates: WorkspaceBriefingCandidate[];
  generatedAt?: Date;
}): NormalizedWorkspaceBriefing {
  const generatedAt = params.generatedAt ?? new Date();
  const rankedCandidates = rankWorkspaceBriefingCandidates(params.candidates, generatedAt);
  const used = new Set<string>();
  const digestEntries = params.digest.sections.flatMap((section, sectionIndex) => (
    section.items.map((rawItem, itemIndex) => {
      const source = pickCandidateForSection(section.id, rawItem, rankedCandidates, used);
      const score = source ? scoreWorkspaceBriefingCandidate(source, generatedAt) : Math.max(4, 8 - itemIndex);
      return {
        digestIndex: sectionIndex * 100 + itemIndex,
        kind: source?.sourceType ?? sectionKind(section.id),
        title: source?.title ?? section.title,
        rawItem,
        whyItMattersMd: source ? whyCandidateMatters(source) : `This was selected for the ${section.title.toLowerCase()} briefing section.`,
        sourceRefs: source?.sourceRefs ?? [],
        href: source?.href ?? null,
        occurredAt: source?.occurredAt ?? generatedAt,
        status: source?.status ?? null,
        confidence: source ? Math.max(0.62, Math.min(0.98, 0.6 + score / 25)) : 0.72,
        score,
      };
    })
  ));
  const items = digestEntries
    .sort((a, b) => (
      b.score - a.score
      || b.occurredAt.getTime() - a.occurredAt.getTime()
      || a.digestIndex - b.digestIndex
    ))
    .map((entry, itemIndex) => ({
      kind: entry.kind,
      title: entry.title,
      summaryMd: compactText(entry.rawItem, itemIndex === 0 ? 900 : 560) ?? entry.rawItem,
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
    });
  }

  return {
    title: params.title,
    introMd: params.digest.intro,
    period: params.period,
    dateKey: params.dateKey,
    generatedAt: generatedAt.toISOString(),
    items,
    sourceRefs: uniqueSourceRefs(items),
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
      const sourceRefs = Array.isArray(entry.sourceRefs)
        ? entry.sourceRefs.flatMap((ref): WorkspaceBriefingSourceRef[] => {
          if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return [];
          const sourceRef = ref as Record<string, unknown>;
          if (typeof sourceRef.type !== "string" || typeof sourceRef.id !== "string" || typeof sourceRef.label !== "string") return [];
          return [{
            type: sourceRef.type as WorkspaceBriefingSourceType,
            id: sourceRef.id,
            label: sourceRef.label,
            href: typeof sourceRef.href === "string" ? sourceRef.href : null,
          }];
        })
        : [];
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

  return {
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : fallbackTitle,
    introMd: typeof record.introMd === "string" && record.introMd.trim() ? record.introMd.trim() : null,
    period,
    dateKey: typeof record.dateKey === "string" && record.dateKey.trim() ? record.dateKey.trim() : dateKeyFromISO(new Date().toISOString()),
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
    items: items.length > 0 ? items : [quietBriefingItem(new Date())],
    sourceRefs: Array.isArray(record.sourceRefs) ? uniqueSourceRefs(items) : uniqueSourceRefs(items),
    sourceCounts: typeof record.sourceCounts === "object" && record.sourceCounts !== null && !Array.isArray(record.sourceCounts)
      ? Object.fromEntries(Object.entries(record.sourceCounts as Record<string, unknown>).flatMap(([key, value]) => (
        typeof value === "number" ? [[key, value]] : []
      )))
      : {},
  };
}

export function workspaceBriefingToNewspaperDigest(input: { briefingJson: unknown } | NormalizedWorkspaceBriefing): NormalizedNewspaperDigest {
  const briefing = "briefingJson" in input ? normalizeWorkspaceBriefingPayload(input.briefingJson) : input;
  const sectionsById = new Map<NewspaperEmailSectionId, string[]>();

  for (const item of briefing.items) {
    const sectionId = sectionForBriefingItem(item);
    const body = [
      item.title,
      item.summaryMd && item.summaryMd !== item.title ? item.summaryMd : null,
      item.whyItMattersMd ? `Why it matters: ${item.whyItMattersMd}` : null,
    ].filter(Boolean).join("\n");
    sectionsById.set(sectionId, [...(sectionsById.get(sectionId) ?? []), body]);
  }

  return {
    intro: briefing.introMd,
    sections: capNewspaperDigestSections([...sectionsById.entries()].map(([id, items]) => ({
      id,
      title: SECTION_TITLES[id],
      items,
    }))),
  };
}

export function renderWorkspaceBriefingMarkdown(briefing: NormalizedWorkspaceBriefing) {
  return renderNewspaperDigestMarkdown({
    title: briefing.title,
    digest: workspaceBriefingToNewspaperDigest(briefing),
  });
}

export async function collectWorkspaceBriefingCandidates(params: {
  workspaceId: string;
  since: Date;
  actor?: AppActor;
}): Promise<WorkspaceBriefingCandidate[]> {
  if (params.actor) {
    await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  }

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
        OR: [
          { recordedAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
          { summaryPostedAt: { gte: params.since } },
          { aiProcessedAt: { gte: params.since } },
        ],
      },
      orderBy: { recordedAt: "desc" },
      take: 20,
      select: { id: true, title: true, summaryMd: true, recordedAt: true, updatedAt: true, decisionsJson: true },
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        isPrivate: false,
        OR: [
          { status: "OPEN" },
          { createdAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
          { publishedAt: { gte: params.since } },
          { decidedAt: { gte: params.since } },
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
        OR: [
          { status: "OPEN" },
          { createdAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
          { resolvedAt: { gte: params.since } },
          { publishedAt: { gte: params.since } },
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
        OR: [
          { createdAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
          { publishedAt: { gte: params.since } },
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
        status: { notIn: ["DRAFT", "ABANDONED"] },
      },
      orderBy: [{ level: "asc" }, { sortOrder: "asc" }, { updatedAt: "desc" }],
      take: 20,
      select: { id: true, title: true, descriptionMd: true, status: true, progressPercent: true, targetDate: true, updatedAt: true, level: true },
    }),
    prisma.recognition.findMany({
      where: { workspaceId: params.workspaceId, createdAt: { gte: params.since } },
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
        OR: [
          { createdAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
          { publishedAt: { gte: params.since } },
          { lastVerifiedAt: { gte: params.since } },
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
        OR: [
          { createdAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, source: true, textContent: true, createdAt: true, updatedAt: true },
    }),
    prisma.communicationContextSummary.findMany({
      where: {
        workspaceId: params.workspaceId,
        summaryDate: { gte: params.since },
      },
      orderBy: { summaryDate: "desc" },
      take: 20,
      select: { id: true, title: true, summaryMd: true, summaryDate: true, updatedAt: true },
    }),
    prisma.buildArtifact.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { status: "OPEN" },
          { updatedAt: { gte: params.since } },
          { mergedAt: { gte: params.since } },
          { closedAt: { gte: params.since } },
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
        OR: [
          { completedAt: { gte: params.since } },
          { updatedAt: { gte: params.since } },
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
      occurredAt: meeting.recordedAt,
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
      occurredAt: article.publishedAt ?? article.updatedAt ?? article.createdAt,
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
      occurredAt: artifact.mergedAt ?? artifact.closedAt ?? artifact.updatedAt,
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
  ];
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
}) {
  const date = new Date(params.dateISO);
  const since = new Date(date.getTime() - PERIOD_LOOKBACK_DAYS[params.period] * 24 * 60 * 60 * 1000);
  const dateKey = dateKeyFromISO(params.dateISO);
  const title = `${params.period === "WEEKLY" ? "Weekly" : "Daily"} Workspace Briefing - ${dateKey}`;
  const runKey = params.workflowJobId ?? `${params.workspaceId}:${params.period.toLowerCase()}-workspace-briefing:${dateKey}`;
  const candidates = await collectWorkspaceBriefingCandidates({
    workspaceId: params.workspaceId,
    since,
  });
  const briefing = buildWorkspaceBriefingFromCandidates({
    workspaceId: params.workspaceId,
    period: params.period,
    dateKey,
    title,
    candidates,
    generatedAt: date,
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
