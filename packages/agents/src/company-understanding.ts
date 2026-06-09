import type { AgentTriggerType, GoalCadence, GoalStatus, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import {
  AGENT_REGISTRY,
  CONTEXT_GRAPH_OBJECT_TYPES,
  CONTEXT_GRAPH_RELATIONSHIP_TYPES,
  createCompanyUnderstandingQuestion,
  createContextGraphProposedDiff,
  createGoal,
  createGoalLink,
  type ContextGraphDiffInput,
} from "@corgtex/domain";
import { executeAgentRun } from "./runtime";

const HIGH_CONFIDENCE = 0.85;
const DRAFT_CONFIDENCE = 0.65;
const COMPANY_UNDERSTANDING_SOURCE = "company-understanding";

type EvidenceRef = {
  sourceType: "BrainSource" | "BrainArticle";
  sourceId: string;
  quote?: string | null;
  label?: string | null;
};

type GoalInsight = {
  title: string;
  descriptionMd: string | null;
  horizon: "short" | "long";
  confidence: number;
  evidenceRefs: EvidenceRef[];
};

type QuestionInsight = {
  questionText: string;
  reason: string | null;
  priority: number;
  confidence: number;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
};

type MapObjectInsight = {
  ref: string;
  objectType: string;
  title: string;
  summary: string | null;
};

type MapRelationshipInsight = {
  sourceRef: string;
  targetRef: string;
  relationshipType: string;
  summary: string | null;
};

type MapProposalInsight = {
  title: string;
  mapType: "org" | "critical-path" | "agent-governance";
  confidence: number;
  evidenceRefs: EvidenceRef[];
  objects: MapObjectInsight[];
  relationships: MapRelationshipInsight[];
};

type NormalizedCompanyUnderstanding = {
  goals: GoalInsight[];
  questions: QuestionInsight[];
  missingEvidence: QuestionInsight[];
  mapProposals: MapProposalInsight[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

function normalizeTitle(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function clampConfidence(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

function normalizePriority(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(10, Math.max(0, Math.round(numeric)));
}

function normalizeEvidence(value: unknown, fallbackSourceId?: string | null): EvidenceRef[] {
  const entries = Array.isArray(value) ? value : [];
  const refs = entries
    .map((entry): EvidenceRef | null => {
      if (!isRecord(entry)) return null;
      const sourceType = asString(entry.sourceType) === "BrainArticle" ? "BrainArticle" : "BrainSource";
      const sourceId = asString(entry.sourceId) || asString(entry.articleId) || asString(entry.sourceId);
      if (!sourceId) return null;
      return {
        sourceType,
        sourceId,
        quote: asString(entry.quote) || null,
        label: asString(entry.label) || null,
      };
    })
    .filter((entry): entry is EvidenceRef => Boolean(entry));

  if (refs.length === 0 && fallbackSourceId) {
    refs.push({ sourceType: "BrainSource", sourceId: fallbackSourceId });
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.sourceType}:${ref.sourceId}:${ref.quote ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeHorizon(value: unknown) {
  const text = asString(value).toLowerCase();
  if (text.includes("long") || text.includes("strategy") || text.includes("annual") || text.includes("year")) {
    return "long" as const;
  }
  return "short" as const;
}

function goalCadenceForHorizon(goal: GoalInsight): GoalCadence {
  return goal.horizon === "long" ? "ANNUAL" : "QUARTERLY";
}

function goalStatusForConfidence(confidence: number): GoalStatus {
  return confidence >= HIGH_CONFIDENCE ? "ACTIVE" : "DRAFT";
}

function normalizeQuestion(entry: unknown, fallbackSourceId?: string | null): QuestionInsight | null {
  if (!isRecord(entry)) return null;
  const questionText = asString(entry.questionText) || asString(entry.question) || asString(entry.request);
  if (!questionText) return null;
  const relatedEntityType = asString(entry.relatedEntityType) || (fallbackSourceId ? "BrainSource" : null);
  const relatedEntityId = asString(entry.relatedEntityId) || fallbackSourceId || null;
  return {
    questionText,
    reason: asString(entry.reason) || null,
    priority: normalizePriority(entry.priority),
    confidence: clampConfidence(entry.confidence),
    relatedEntityType,
    relatedEntityId,
  };
}

function normalizeMapType(value: unknown): MapProposalInsight["mapType"] {
  const text = asString(value).toLowerCase();
  if (text.includes("agent")) return "agent-governance";
  if (text.includes("org") || text.includes("team") || text.includes("role")) return "org";
  return "critical-path";
}

function normalizeMapProposal(entry: unknown, _fallbackSourceId?: string | null): MapProposalInsight | null {
  if (!isRecord(entry)) return null;
  const title = asString(entry.title) || asString(entry.name) || "Company understanding map proposal";
  const evidenceRefs = normalizeEvidence(entry.evidenceRefs, null);
  const objects = Array.isArray(entry.objects)
    ? entry.objects.map((object, index) => {
        if (!isRecord(object)) return null;
        const title = asString(object.title);
        const objectType = asString(object.objectType);
        if (!title || !CONTEXT_GRAPH_OBJECT_TYPES.includes(objectType as any)) return null;
        return {
          ref: asString(object.ref) || `object-${index + 1}`,
          objectType,
          title,
          summary: asString(object.summary) || null,
        };
      }).filter((object): object is MapObjectInsight => Boolean(object))
    : [];
  const objectRefs = new Set(objects.map((object) => object.ref));
  const relationships = Array.isArray(entry.relationships)
    ? entry.relationships.map((relationship) => {
        if (!isRecord(relationship)) return null;
        const sourceRef = asString(relationship.sourceRef);
        const targetRef = asString(relationship.targetRef);
        const relationshipType = asString(relationship.relationshipType);
        if (
          !objectRefs.has(sourceRef)
          || !objectRefs.has(targetRef)
          || !CONTEXT_GRAPH_RELATIONSHIP_TYPES.includes(relationshipType as any)
        ) {
          return null;
        }
        return {
          sourceRef,
          targetRef,
          relationshipType,
          summary: asString(relationship.summary) || null,
        };
      }).filter((relationship): relationship is MapRelationshipInsight => Boolean(relationship))
    : [];

  return {
    title,
    mapType: normalizeMapType(entry.mapType ?? entry.type),
    confidence: clampConfidence(entry.confidence),
    evidenceRefs,
    objects,
    relationships,
  };
}

export function normalizeCompanyUnderstandingOutput(output: unknown, fallbackSourceId?: string | null): NormalizedCompanyUnderstanding {
  const record = isRecord(output) ? output : {};
  return {
    goals: (Array.isArray(record.goals) ? record.goals : [])
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const title = asString(entry.title);
        if (!title) return null;
        return {
          title,
          descriptionMd: asString(entry.descriptionMd) || asString(entry.summary) || null,
          horizon: normalizeHorizon(entry.horizon ?? entry.goalType),
          confidence: clampConfidence(entry.confidence),
          evidenceRefs: normalizeEvidence(entry.evidenceRefs, fallbackSourceId),
        } satisfies GoalInsight;
      })
      .filter((entry): entry is GoalInsight => Boolean(entry)),
    questions: (Array.isArray(record.openQuestions) ? record.openQuestions : Array.isArray(record.questions) ? record.questions : [])
      .map((entry) => normalizeQuestion(entry, fallbackSourceId))
      .filter((entry): entry is QuestionInsight => Boolean(entry)),
    missingEvidence: (Array.isArray(record.missingEvidence) ? record.missingEvidence : [])
      .map((entry) => normalizeQuestion(entry, fallbackSourceId))
      .filter((entry): entry is QuestionInsight => Boolean(entry)),
    mapProposals: (Array.isArray(record.mapProposals) ? record.mapProposals : Array.isArray(record.mapFacts) ? record.mapFacts : [])
      .map((entry) => normalizeMapProposal(entry, fallbackSourceId))
      .filter((entry): entry is MapProposalInsight => Boolean(entry)),
  };
}

function companyUnderstandingActor(): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "company-understanding",
    scopes: ["context-graph:propose"],
  };
}

async function resolveQuestionMemberId(workspaceId: string) {
  const preferred = await prisma.member.findFirst({
    where: { workspaceId, isActive: true, role: { in: ["ADMIN", "FACILITATOR"] } },
    orderBy: { joinedAt: "asc" },
    select: { id: true },
  });
  if (preferred) return preferred.id;

  const fallback = await prisma.member.findFirst({
    where: { workspaceId, isActive: true },
    orderBy: { joinedAt: "asc" },
    select: { id: true },
  });
  return fallback?.id ?? null;
}

async function createQuestionIfNew(actor: AppActor, workspaceId: string, memberId: string | null, question: QuestionInsight, metadata?: Prisma.InputJsonObject) {
  if (!memberId) return { kind: "question" as const, skipped: true, reason: "no_member" };
  const existing = await prisma.checkIn.findFirst({
    where: {
      workspaceId,
      memberId,
      questionType: "COMPANY_UNDERSTANDING",
      status: "OPEN",
      questionText: question.questionText,
    },
    select: { id: true },
  });
  if (existing) return { kind: "question" as const, skipped: true, reason: "duplicate_question", id: existing.id };
  const created = await createCompanyUnderstandingQuestion(actor, {
    workspaceId,
    memberId,
    questionText: question.questionText,
    questionSource: COMPANY_UNDERSTANDING_SOURCE,
    priority: question.priority,
    confidence: question.confidence,
    relatedEntityType: question.relatedEntityType,
    relatedEntityId: question.relatedEntityId,
    metadata: {
      ...(metadata ?? {}),
      reason: question.reason,
      responsePositioning: "Employee answers become company knowledge by default.",
    },
  });
  return { kind: "question" as const, created: true, id: created.id };
}

async function linkGoalEvidence(actor: AppActor, workspaceId: string, goalId: string, goal: GoalInsight, agentRunId: string) {
  for (const evidence of goal.evidenceRefs) {
    await createGoalLink(actor, {
      workspaceId,
      goalId,
      entityType: evidence.sourceType,
      entityId: evidence.sourceId,
      confidence: goal.confidence,
      linkedBy: COMPANY_UNDERSTANDING_SOURCE,
      source: COMPANY_UNDERSTANDING_SOURCE,
      metadata: {
        quote: evidence.quote,
        label: evidence.label,
        insightTitle: goal.title,
        agentRunId,
      },
    });
  }
}

async function applyGoalInsight(actor: AppActor, workspaceId: string, goal: GoalInsight, agentRunId: string, questionMemberId: string | null) {
  const existingGoals = await prisma.goal.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true, title: true },
    take: 200,
  });
  const existing = existingGoals.find((candidate) => normalizeTitle(candidate.title) === normalizeTitle(goal.title));

  if (goal.confidence < DRAFT_CONFIDENCE || goal.evidenceRefs.length === 0) {
    return createQuestionIfNew(actor, workspaceId, questionMemberId, {
      questionText: goal.evidenceRefs.length === 0
        ? `What evidence supports this possible company goal: ${goal.title}?`
        : `Should this become a company goal: ${goal.title}?`,
      reason: goal.descriptionMd,
      priority: 7,
      confidence: goal.confidence,
      relatedEntityType: goal.evidenceRefs[0]?.sourceType ?? null,
      relatedEntityId: goal.evidenceRefs[0]?.sourceId ?? null,
    }, { generatedFrom: "goal-low-confidence", title: goal.title });
  }

  const target = existing ?? await createGoal(actor, {
    workspaceId,
    title: goal.title,
    descriptionMd: goal.descriptionMd,
    level: "COMPANY",
    cadence: goalCadenceForHorizon(goal),
    status: goalStatusForConfidence(goal.confidence),
  });

  await linkGoalEvidence(actor, workspaceId, target.id, goal, agentRunId);
  return { kind: "goal" as const, created: !existing, updated: Boolean(existing), id: target.id, status: goalStatusForConfidence(goal.confidence) };
}

function mapQuestionForProposal(proposal: MapProposalInsight): QuestionInsight {
  return {
    questionText: proposal.evidenceRefs.length === 0
      ? `What evidence should CORGTEX use before proposing the ${proposal.mapType} map item "${proposal.title}"?`
      : `Can you clarify the missing relationships for the ${proposal.mapType} map item "${proposal.title}"?`,
    reason: "Context-map proposals must be evidence-backed before they become map facts.",
    priority: 6,
    confidence: proposal.confidence,
    relatedEntityType: proposal.evidenceRefs[0]?.sourceType ?? null,
    relatedEntityId: proposal.evidenceRefs[0]?.sourceId ?? null,
  };
}

async function applyMapProposal(actor: AppActor, workspaceId: string, proposal: MapProposalInsight, agentRunId: string, questionMemberId: string | null) {
  if (proposal.confidence < DRAFT_CONFIDENCE || proposal.evidenceRefs.length === 0 || proposal.objects.length === 0) {
    return createQuestionIfNew(actor, workspaceId, questionMemberId, mapQuestionForProposal(proposal), {
      generatedFrom: "map-low-confidence",
      mapType: proposal.mapType,
      title: proposal.title,
    });
  }

  const reason = `Company understanding proposal: ${proposal.mapType}: ${proposal.title}`;
  const existing = await prisma.contextGraphProposedDiff.findFirst({
    where: { workspaceId, status: "pending", reason },
    select: { id: true },
  });
  if (existing) return { kind: "map-proposal" as const, skipped: true, reason: "duplicate_map_proposal", id: existing.id };

  const primaryEvidence = proposal.evidenceRefs[0];
  const diff: ContextGraphDiffInput = {
    objects: proposal.objects.map((object) => ({
      ref: object.ref,
      objectType: object.objectType,
      title: object.title,
      summary: object.summary,
      confidence: proposal.confidence,
      status: "proposed",
      sourceEntityType: primaryEvidence.sourceType,
      sourceEntityId: primaryEvidence.sourceId,
      dedupeKey: `${COMPANY_UNDERSTANDING_SOURCE}:${proposal.mapType}:${normalizeTitle(object.title)}`,
      properties: { mapType: proposal.mapType },
    })),
    relationships: proposal.relationships.map((relationship) => ({
      sourceRef: relationship.sourceRef,
      targetRef: relationship.targetRef,
      relationshipType: relationship.relationshipType,
      confidence: proposal.confidence,
      status: "proposed",
      sourceEntityType: primaryEvidence.sourceType,
      sourceEntityId: primaryEvidence.sourceId,
      properties: { summary: relationship.summary, mapType: proposal.mapType },
    })),
    evidenceRefs: proposal.objects.flatMap((object) => (
      proposal.evidenceRefs.map((evidence) => ({
        objectRef: object.ref,
        sourceType: evidence.sourceType,
        sourceId: evidence.sourceId,
        quote: evidence.quote,
        relevanceScore: proposal.confidence,
        metadata: { mapType: proposal.mapType, label: evidence.label },
      }))
    )),
  };

  const created = await createContextGraphProposedDiff(actor, {
    workspaceId,
    diff,
    reason,
    evidence: {
      source: COMPANY_UNDERSTANDING_SOURCE,
      mapType: proposal.mapType,
      evidenceRefs: proposal.evidenceRefs,
      agentRunId,
    },
    agentRunId,
  });
  return { kind: "map-proposal" as const, created: true, id: created.id };
}

export async function runCompanyUnderstandingSynthesis(params: {
  workspaceId: string;
  agentRunId: string;
  sourceId?: string | null;
  model: string;
}) {
  const actor = companyUnderstandingActor();
  const [sources, articles] = await Promise.all([
    prisma.brainSource.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        absorbedAt: { not: null },
        ...(params.sourceId ? { id: params.sourceId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.sourceId ? 1 : 20,
      select: { id: true, sourceType: true, tier: true, title: true, content: true, ingestionGuidanceMd: true, absorbedAt: true },
    }),
    prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { id: true, slug: true, title: true, type: true, authority: true, bodyMd: true, sourceIds: true },
    }),
  ]);

  if (sources.length === 0 && articles.length === 0) {
    return { skipped: true, reason: "no_brain_evidence" };
  }

  const existingGoals = await prisma.goal.findMany({
    where: { workspaceId: params.workspaceId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { title: true, status: true, cadence: true },
  });

  const extraction = await defaultModelGateway.extract({
    model: params.model,
    workspaceId: params.workspaceId,
    agentRunId: params.agentRunId,
    instruction: `Synthesize absorbed Brain evidence into company understanding.

Return only evidence-backed items:
- goals: short-term decisions/quarterly goals and long-term strategy/annual goals
- openQuestions and missingEvidence: questions employees can answer, including upload requests
- mapProposals: proposal-first facts for org, critical-path, and agent-governance context maps

Rules:
- Every goal and map proposal must cite BrainSource or BrainArticle evidenceRefs.
- Do not invent map nodes. If evidence is insufficient, create a question instead.
- Confidence is 0 to 1.
- High confidence is >= 0.85, draft/proposal confidence is 0.65-0.84, below 0.65 should become a question.
- Avoid duplicates of existing goals.

Expected JSON shape:
{
  "goals": [{"title":"", "summary":"", "horizon":"short|long", "confidence":0.0, "evidenceRefs":[{"sourceType":"BrainSource|BrainArticle","sourceId":"","quote":""}]}],
  "openQuestions": [{"questionText":"", "reason":"", "priority":0, "confidence":0.0, "relatedEntityType":"BrainSource|BrainArticle", "relatedEntityId":""}],
  "missingEvidence": [{"request":"", "reason":"", "priority":0, "confidence":0.0, "relatedEntityType":"BrainSource|BrainArticle", "relatedEntityId":""}],
  "mapProposals": [{"title":"", "mapType":"org|critical-path|agent-governance", "confidence":0.0, "evidenceRefs":[{"sourceType":"BrainSource|BrainArticle","sourceId":"","quote":""}], "objects":[{"ref":"", "objectType":"Person|Team|Role|Process|ProcessStep|Project|Decision|Tool|Risk|Agent|Question|Evidence", "title":"", "summary":""}], "relationships":[{"sourceRef":"", "targetRef":"", "relationshipType":"owns|member_of|reports_to|depends_on|blocks|uses|supports|part_of|input_to|output_of", "summary":""}]}]
}`,
    schemaHint: "CompanyUnderstandingSynthesis",
    input: JSON.stringify({
      triggerSourceId: params.sourceId ?? null,
      sources: sources.map((source) => ({
        id: source.id,
        sourceType: source.sourceType,
        tier: source.tier,
        title: source.title,
        content: source.content.slice(0, 2500),
        ingestionGuidanceMd: source.ingestionGuidanceMd,
      })),
      articles: articles.map((article) => ({
        id: article.id,
        slug: article.slug,
        title: article.title,
        type: article.type,
        authority: article.authority,
        sourceIds: article.sourceIds,
        bodyMd: article.bodyMd.slice(0, 2000),
      })),
      existingGoals,
    }),
  });

  const normalized = normalizeCompanyUnderstandingOutput(extraction.output, params.sourceId);
  const questionMemberId = await resolveQuestionMemberId(params.workspaceId);
  const goalResults = [];
  const questionResults = [];
  const mapResults = [];

  for (const goal of normalized.goals) {
    goalResults.push(await applyGoalInsight(actor, params.workspaceId, goal, params.agentRunId, questionMemberId));
  }
  for (const question of [...normalized.questions, ...normalized.missingEvidence]) {
    questionResults.push(await createQuestionIfNew(actor, params.workspaceId, questionMemberId, question, {
      generatedFrom: "company-understanding",
    }));
  }
  for (const proposal of normalized.mapProposals) {
    mapResults.push(await applyMapProposal(actor, params.workspaceId, proposal, params.agentRunId, questionMemberId));
  }

  return {
    synthesized: true,
    sourceCount: sources.length,
    articleCount: articles.length,
    generatedGoals: goalResults.filter((result) => result.kind === "goal" && "created" in result && result.created).length,
    updatedGoals: goalResults.filter((result) => result.kind === "goal" && "updated" in result && result.updated).length,
    questions: [...questionResults, ...goalResults, ...mapResults].filter((result) => result.kind === "question" && "created" in result && result.created).length,
    mapProposals: mapResults.filter((result) => result.kind === "map-proposal" && "created" in result && result.created).length,
    lowConfidenceFallbacks: [...goalResults, ...mapResults].filter((result) => result.kind === "question").length,
  };
}

export async function runCompanyUnderstandingAgent(params: {
  workspaceId: string;
  triggerRef: string;
  sourceId?: string | null;
  triggerType: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "company-understanding",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType,
    triggerRef: params.triggerRef,
    goal: "Synthesize absorbed Brain evidence into evidence-backed company goals, questions, and context-map proposals.",
    payload: { sourceId: params.sourceId ?? null },
    plan: ["load-brain-evidence", "extract-company-understanding", "apply-thresholds", "persist-goals-questions-map-proposals"],
    buildContext: async (helpers) =>
      helpers.tool("brain.company-understanding-context", { sourceId: params.sourceId ?? null }, async () => ({
        sourceId: params.sourceId ?? null,
      })),
    execute: async (_context, helpers, runId, model) =>
      helpers.step("synthesize-company-understanding", { sourceId: params.sourceId ?? null }, async () => ({
        resultJson: await runCompanyUnderstandingSynthesis({
          workspaceId: params.workspaceId,
          agentRunId: runId,
          sourceId: params.sourceId ?? null,
          model,
        }),
      })),
  });
}
