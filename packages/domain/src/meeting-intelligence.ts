import { createHash } from "node:crypto";
import type { MeetingInsightType, MeetingInsight, MeetingInsightOperation, Prisma, ProposalResolutionOutcome } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { defaultModelGateway } from "@corgtex/models";
import { createAction, updateAction } from "./actions";
import { createTension, updateTension } from "./tensions";
import { createProposal, createProposalFromTension, resolveProposal, submitProposal } from "./proposals";
import { postDeliberationEntry } from "./deliberation";
import { buildMeetingIntelligenceContext } from "./meeting-intelligence-context";
import { shouldBypassAutoApplyForSlackMeetingActionReview } from "./meeting-action-review";
import {
  normalizeMeetingProductTerminology,
  prependMeetingBlockContext,
  resolveMeetingBlockReference,
  stripMeetingBlockContext,
} from "./meeting-blocks";

const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.8;
const AUTO_APPLY_DELIBERATION_THRESHOLD = 0.85;
const AUTO_APPLY_PROPOSAL_RESOLUTION_THRESHOLD = 0.92;
const MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS = 35_000;
const INSIGHT_TRANSCRIPT_EXCERPT_CHARS = 8_000;
const MEETING_INSIGHT_TYPES = new Set<MeetingInsightType>([
  "DECISION",
  "TENSION",
  "ACTION_ITEM",
  "PROPOSAL",
  "FOLLOW_UP",
  "DELIBERATION_ENTRY",
]);
const MEETING_INSIGHT_TYPE_ALIASES: Record<string, MeetingInsightType> = {
  ACTION: "ACTION_ITEM",
  ACTIONS: "ACTION_ITEM",
  ACTION_ITEMS: "ACTION_ITEM",
  DECISIONS: "DECISION",
  FOLLOWUP: "FOLLOW_UP",
  FOLLOWUPS: "FOLLOW_UP",
  FOLLOW_UPS: "FOLLOW_UP",
  PROPOSALS: "PROPOSAL",
  DELIBERATION: "DELIBERATION_ENTRY",
  DELIBERATION_ENTRIES: "DELIBERATION_ENTRY",
  DISCUSSION: "DELIBERATION_ENTRY",
  DISCUSSION_NOTE: "DELIBERATION_ENTRY",
  TENSIONS: "TENSION",
};
const RESOLUTION_OUTCOMES = new Set<ProposalResolutionOutcome>([
  "ADOPTED",
  "NOT_ADOPTED",
  "WITHDRAWN",
]);
const DELIBERATION_ENTRY_TYPES = new Set(["REACTION", "OBJECTION"]);

function excerptLongTranscript(transcript: string) {
  if (transcript.length <= MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS) {
    return transcript;
  }

  const middleStart = Math.max(
    INSIGHT_TRANSCRIPT_EXCERPT_CHARS,
    Math.floor(transcript.length / 2) - Math.floor(INSIGHT_TRANSCRIPT_EXCERPT_CHARS / 2),
  );
  const middleEnd = Math.min(transcript.length - INSIGHT_TRANSCRIPT_EXCERPT_CHARS, middleStart + INSIGHT_TRANSCRIPT_EXCERPT_CHARS);

  return [
    `The full transcript is ${transcript.length} characters and was shortened for extraction to avoid model timeouts. Use summaryMd first, then these transcript excerpts as supporting evidence.`,
    `BEGINNING EXCERPT:\n${transcript.slice(0, INSIGHT_TRANSCRIPT_EXCERPT_CHARS)}`,
    `MIDDLE EXCERPT:\n${transcript.slice(middleStart, middleEnd)}`,
    `ENDING EXCERPT:\n${transcript.slice(-INSIGHT_TRANSCRIPT_EXCERPT_CHARS)}`,
  ].join("\n\n---\n\n");
}

function normalizeInsightType(value: unknown, targetEntityType: string | null): MeetingInsightType | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (MEETING_INSIGHT_TYPES.has(normalized as MeetingInsightType)) {
    return normalized as MeetingInsightType;
  }

  const alias = MEETING_INSIGHT_TYPE_ALIASES[normalized];
  if (alias) {
    return alias;
  }

  if (normalized === "RESOLUTION" || normalized === "RESOLUTIONS") {
    if (targetEntityType === "Action") return "ACTION_ITEM";
    if (targetEntityType === "Tension") return "TENSION";
    if (targetEntityType === "Proposal") return "PROPOSAL";
  }

  return null;
}

function normalizeResolutionOutcome(
  value: unknown,
  operation: "CREATE" | "RESOLVE",
  targetEntityType: string | null,
): ProposalResolutionOutcome | null {
  if (operation !== "RESOLVE" || targetEntityType !== "Proposal" || typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return RESOLUTION_OUTCOMES.has(normalized as ProposalResolutionOutcome)
    ? normalized as ProposalResolutionOutcome
    : null;
}

function normalizeDeliberationEntryType(value: unknown) {
  if (typeof value !== "string") return "REACTION";
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return DELIBERATION_ENTRY_TYPES.has(normalized) ? normalized : "REACTION";
}

function normalizeTargetEntityType(value: unknown) {
  if (value === "Action" || value === "Tension" || value === "Proposal") {
    return value;
  }
  return null;
}

function normalizeDueAt(value: unknown) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value.trim());
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeInsightTitle(value: unknown) {
  if (typeof value !== "string") return "";
  let title = value.trim();
  for (let index = 0; index < 3; index += 1) {
    const stripped = title
      .replace(/^(?:item\s*)?(?:#\s*)?\d{1,4}\s*(?:[.)\]-]|>)\s*/i, "")
      .trim();
    if (stripped === title) break;
    title = stripped;
  }
  return title;
}

function extractTechnicalBodyFields(bodyMd: string) {
  const markerPattern = /\*{0,2}(CONTEXT|REQUEST|ANSWER|RESULT):\*{0,2}/gi;
  const markers = [...bodyMd.matchAll(markerPattern)];
  if (markers.length === 0) return null;

  const fields: Partial<Record<"CONTEXT" | "REQUEST" | "ANSWER" | "RESULT", string>> = {};
  markers.forEach((marker, index) => {
    const key = marker[1]?.toUpperCase() as "CONTEXT" | "REQUEST" | "ANSWER" | "RESULT";
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? bodyMd.length;
    const value = bodyMd.slice(start, end).trim();
    if (value) fields[key] = value;
  });

  return Object.keys(fields).length > 0 ? fields : null;
}

function markdownSections(sections: Array<{ title: string; body?: string | null }>) {
  return sections
    .map((section) => {
      const body = section.body?.trim();
      return body ? `### ${section.title}\n${body}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeInsightBody(bodyMd: string, type: MeetingInsightType) {
  const body = bodyMd.trim();
  const fields = extractTechnicalBodyFields(body);
  if (!fields) return body;

  if (type === "ACTION_ITEM") {
    return markdownSections([
      { title: "Outcome", body: fields.ANSWER || fields.REQUEST },
      { title: "Owner and timing", body: fields.RESULT },
      { title: "Context", body: fields.CONTEXT },
    ]) || body;
  }

  if (type === "FOLLOW_UP") {
    return markdownSections([
      { title: "Follow-up topic", body: fields.REQUEST || fields.ANSWER },
      { title: "Why it matters", body: fields.CONTEXT },
      { title: "Current status", body: fields.RESULT },
    ]) || body;
  }

  if (type === "TENSION") {
    return markdownSections([
      { title: "Current reality", body: fields.CONTEXT },
      { title: "Gap / desired future", body: fields.REQUEST },
      { title: "Why it matters", body: fields.ANSWER },
      { title: "Current status", body: fields.RESULT },
    ]) || body;
  }

  if (type === "PROPOSAL") {
    return markdownSections([
      { title: "Tension / why", body: fields.CONTEXT },
      { title: "Proposed change", body: fields.REQUEST || fields.ANSWER },
      { title: "Expected effect", body: fields.REQUEST && fields.ANSWER ? fields.ANSWER : null },
      { title: "Open questions", body: fields.RESULT },
    ]) || body;
  }

  if (type === "DECISION") {
    return markdownSections([
      { title: "Decision", body: fields.ANSWER || fields.RESULT },
      { title: "Context", body: fields.CONTEXT },
      { title: "What was considered", body: fields.REQUEST },
    ]) || body;
  }

  return markdownSections([
    { title: "Discussion context", body: fields.CONTEXT },
    { title: "Point raised", body: fields.REQUEST || fields.ANSWER },
    { title: "Current status", body: fields.RESULT },
  ]) || body;
}

function deterministicInsightDedupeKey(params: {
  meetingId: string;
  type: MeetingInsightType;
  operation: "CREATE" | "RESOLVE";
  title: string;
  bodyMd: string;
  targetEntityType: string | null;
  targetEntityId: string | null;
  deliberationEntryType: string | null;
  resolutionOutcome: ProposalResolutionOutcome | null;
}) {
  const normalized = [
    params.meetingId,
    params.type,
    params.operation,
    params.targetEntityType ?? "",
    params.targetEntityId ?? "",
    params.deliberationEntryType ?? "",
    params.resolutionOutcome ?? "",
    params.title.toLowerCase().replace(/\s+/g, " ").trim(),
    params.bodyMd.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 600),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function autoApplyThresholdForInsight(insight: Pick<MeetingInsight, "type" | "operation" | "targetEntityType">) {
  if (insight.operation === "RESOLVE" && insight.targetEntityType === "Proposal") {
    return AUTO_APPLY_PROPOSAL_RESOLUTION_THRESHOLD;
  }
  if (insight.type === "DELIBERATION_ENTRY") {
    return AUTO_APPLY_DELIBERATION_THRESHOLD;
  }
  return AUTO_APPLY_CONFIDENCE_THRESHOLD;
}

function hasMeetingEvidenceForAutoApply(insight: Pick<MeetingInsight, "operation" | "targetEntityType" | "sourceQuote">) {
  if (insight.operation === "RESOLVE" && insight.targetEntityType === "Proposal") {
    return Boolean(insight.sourceQuote?.trim());
  }
  return true;
}

export async function extractMeetingInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string }
): Promise<MeetingInsight[]> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  let meetingContext;
  try {
    meetingContext = await buildMeetingIntelligenceContext({
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      mode: "insights",
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404 && error.code === "NOT_FOUND") {
      const archivedMeeting = await prisma.meeting.findFirst({
        where: {
          id: params.meetingId,
          workspaceId: params.workspaceId,
          archivedAt: { not: null },
        },
        select: { id: true },
      });
      if (archivedMeeting) {
        return [];
      }
    }
    throw error;
  }
  const meeting = meetingContext.meeting;

  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  invariant(meeting.transcript, 400, "INVALID_STATE", "Meeting has no transcript to analyze.");
  const latestSourceRecord = await prisma.meetingTranscriptSourceRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
      status: "ACTIVE",
    },
    orderBy: [
      { sourceUpdatedAt: { sort: "desc", nulls: "last" } },
      { recordedAt: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      id: true,
      recordedAt: true,
      sourceUpdatedAt: true,
    },
  });

  const instruction = `
You are analyzing a meeting transcript for a self-managed organization.
Extract all:
- DECISIONS: Agreements or choices made during the meeting
- TENSIONS: Unresolved issues, concerns, or gaps identified
- ACTION_ITEMS: Tasks assigned to specific people with next steps
- PROPOSALS: New ideas or changes proposed for the organization
- FOLLOW_UPS: Items that need to be discussed in the next meeting
- DELIBERATION_ENTRIES: Notes about discussion on an existing proposal or tension
- RESOLUTIONS: existing actions, tensions, or proposals that the meeting clearly completed, resolved, adopted, rejected, or withdrew

Use any user-provided ingestion guidance to prioritize what matters and what follow-up work the operator wanted highlighted. Treat guidance as trusted operator context for spelling, name, and terminology corrections. When guidance corrects a transcript term, use the corrected term in titles and body text. Do not invent new decisions, tasks, tensions, proposals, or resolutions from guidance alone. If an item mainly comes from guidance rather than transcript evidence, say that clearly in the body and leave sourceQuote null.
Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in human-facing titles, bodies, source quotes, and meeting block labels.
If transcriptCondensedForExtraction is true, the full transcript was too large for direct structured extraction. Use summaryMd as the primary meeting digest and the transcript excerpts only as supporting evidence. Do not treat the transcript-shortening note itself as meeting content.
When contextual intelligence is enabled, use Corgtex context to connect the meeting to previous recurring meetings, active actions, active tensions, open proposals, recent deliberation, and relevant knowledge. Prefer updating or discussing existing records over creating duplicates.
Use meetingBlocks as the conversation map. Assign each extracted item to the most relevant block using blockSequence, blockTitle, and blockKind. If a proposal discussion leads to a decision or resolution, keep that connection in the body and target fields when supported by existingRecords.
Treat owner-backed commitments as ACTION_ITEM items even when they appear in summaryMd, key takeaways, action item sections, or indirect transcript wording. If someone says they will do something, needs to contact someone, owns a follow-up, or must prepare a next step, extract a concrete ACTION_ITEM with that owner when the evidence is clear.

For each item, provide:
- operation: CREATE for new records/decisions/follow-ups, RESOLVE for existing records resolved in this meeting
- type: one of DECISION, TENSION, ACTION_ITEM, PROPOSAL, FOLLOW_UP, DELIBERATION_ENTRY
- title: a concise human title with no generated item number, no # prefix, and no ">" separator
- body: human-first Markdown, not machine metadata. Do not use all-caps labels like CONTEXT, REQUEST, ANSWER, RESULT, MEETING BLOCK, or BLOCK KIND.
  For TENSION items, structure the body around current reality, gap / desired future, why it matters, and likely processing path.
  For PROPOSAL items, structure the body around tension / why, proposed change, expected effect, and open questions.
  For ACTION_ITEM and FOLLOW_UP items, structure the body around concrete outcome, owner, due date if stated, and context.
  For DECISION and DELIBERATION_ENTRY items, explain what was decided or discussed, what evidence supports it, and what remains open.
- assigneeHint: who is responsible (display name from transcript), or null
- dueAt: ISO 8601 due date/time for ACTION_ITEM or FOLLOW_UP only when the meeting explicitly states one, otherwise null
- confidence: 0.0-1.0 how confident you are
- sourceQuote: the relevant transcript or summary excerpt (max 200 chars)
- targetEntityType and targetEntityId only for RESOLVE items, DECISION items tied to an existing Proposal or Tension, using the existing records supplied in the input
- targetEntityType and targetEntityId are also required for DELIBERATION_ENTRY items and for PROPOSAL items that should be drafted from an existing Tension
- deliberationEntryType only for DELIBERATION_ENTRY items: REACTION or OBJECTION
- resolutionOutcome only for resolved proposals: ADOPTED, NOT_ADOPTED, or WITHDRAWN
- blockSequence, blockTitle, and blockKind for the meeting block that produced this item
- dedupeKey: stable lowercase key based on type, target, and the discussed topic

Be conservative — only extract items you're confident about.
`;

  const schemaHint = `
{
  "type": "object",
  "properties": {
    "insights": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["DECISION", "TENSION", "ACTION_ITEM", "PROPOSAL", "FOLLOW_UP", "DELIBERATION_ENTRY"] },
          "operation": { "type": "string", "enum": ["CREATE", "RESOLVE"] },
          "title": { "type": "string" },
          "body": { "type": "string" },
          "assigneeHint": { "type": "string" },
          "dueAt": { "type": "string" },
          "confidence": { "type": "number" },
          "sourceQuote": { "type": "string" },
          "targetEntityType": { "type": "string", "enum": ["Action", "Tension", "Proposal"] },
          "targetEntityId": { "type": "string" },
          "deliberationEntryType": { "type": "string", "enum": ["REACTION", "OBJECTION"] },
          "resolutionOutcome": { "type": "string", "enum": ["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"] },
          "blockSequence": { "type": "number" },
          "blockTitle": { "type": "string" },
          "blockKind": { "type": "string" },
          "dedupeKey": { "type": "string" }
        },
        "required": ["type", "title", "body", "confidence"]
      }
    }
  },
  "required": ["insights"]
}
`;

  const extraction = await defaultModelGateway.extract({
    workspaceId: params.workspaceId,
    instruction,
    input: JSON.stringify({
      transcript: excerptLongTranscript(meeting.transcript),
      transcriptLength: meeting.transcript.length,
      transcriptCondensedForExtraction: meeting.transcript.length > MAX_DIRECT_INSIGHT_TRANSCRIPT_CHARS,
      summaryMd: meeting.summaryMd,
      meetingBlocks: meeting.blocksJson,
      ingestionGuidanceMd: meeting.ingestionGuidanceMd,
      contextualIntelligenceEnabled: meetingContext.contextualIntelligenceEnabled,
      existingRecords: {
        actions: meetingContext.actions,
        tensions: meetingContext.tensions,
        proposals: meetingContext.proposals,
      },
      corgtexContext: meetingContext.contextualIntelligenceEnabled ? {
        previousMeetings: meetingContext.previousMeetings,
        followUps: meetingContext.followUps,
        recentDeliberation: meetingContext.deliberationEntries,
        knowledge: meetingContext.knowledge,
        attendees: meetingContext.attendees,
      } : null,
      automationPolicy: {
        createRecordsAt: AUTO_APPLY_CONFIDENCE_THRESHOLD,
        deliberationAt: AUTO_APPLY_DELIBERATION_THRESHOLD,
        proposalResolutionAt: AUTO_APPLY_PROPOSAL_RESOLUTION_THRESHOLD,
      },
    }),
    schemaHint,
  });

  const parsed = extraction.output as { insights?: Array<Record<string, unknown>> };
  const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

  const validTargets = new Map<string, string>([
    ...meetingContext.actions.map((item: { id: string }) => [`Action:${item.id}`, item.id] as const),
    ...meetingContext.tensions.map((item: { id: string }) => [`Tension:${item.id}`, item.id] as const),
    ...meetingContext.proposals.map((item: { id: string }) => [`Proposal:${item.id}`, item.id] as const),
  ]);
  const resolvableProposalIds = new Set(meetingContext.proposals
    .filter((item: { id: string; status: string }) => item.status === "OPEN")
    .map((item: { id: string }) => item.id));

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const createdInsights: MeetingInsight[] = [];
    const seenDedupeKeys = new Set<string>();

    await tx.meetingInsight.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        meetingId: meeting.id,
        status: "SUGGESTED",
        sourceRecordId: null,
      },
    });
    
    for (const item of insights) {
      const targetEntityType = normalizeTargetEntityType(item.targetEntityType);
      const targetEntityId = typeof item.targetEntityId === "string" ? item.targetEntityId.trim() : null;
      const targetKey = targetEntityType && targetEntityId ? `${targetEntityType}:${targetEntityId}` : null;
      const hasValidTarget = Boolean(targetKey && validTargets.has(targetKey));
      if (targetKey && !hasValidTarget) continue;

      const requestedOperation: MeetingInsightOperation = item.operation === "RESOLVE" ? "RESOLVE" : "CREATE";
      if (requestedOperation === "RESOLVE" && !hasValidTarget) continue;
      if (requestedOperation === "RESOLVE" && targetEntityType === "Proposal" && targetEntityId && !resolvableProposalIds.has(targetEntityId)) continue;

      const type = normalizeInsightType(item.type, requestedOperation === "RESOLVE" ? targetEntityType : null);
      const title = normalizeInsightTitle(normalizeMeetingProductTerminology(typeof item.title === "string" ? item.title : ""));
      const block = resolveMeetingBlockReference(meeting.blocksJson, {
        sequence: typeof item.blockSequence === "number" ? item.blockSequence : null,
        title: typeof item.blockTitle === "string" ? normalizeMeetingProductTerminology(item.blockTitle) : null,
        kind: typeof item.blockKind === "string" ? item.blockKind : null,
      });
      if (!type) continue;
      const rawBody = typeof item.body === "string" ? normalizeMeetingProductTerminology(item.body).trim() : "";
      const bodyMd = prependMeetingBlockContext(normalizeInsightBody(rawBody, type), block);
      if (!type || title.length === 0 || bodyMd.length === 0) continue;

      const isDeliberationEntry = type === "DELIBERATION_ENTRY";
      const operation: MeetingInsightOperation = isDeliberationEntry ? "CREATE" : requestedOperation;
      const resolutionOutcome = normalizeResolutionOutcome(item.resolutionOutcome, operation, targetEntityType);
      if (operation === "RESOLVE" && targetEntityType === "Proposal" && !resolutionOutcome) continue;

      if (isDeliberationEntry && (!hasValidTarget || (targetEntityType !== "Proposal" && targetEntityType !== "Tension"))) {
        continue;
      }

      const keepTarget = hasValidTarget && (
        operation === "RESOLVE" ||
        isDeliberationEntry ||
        (type === "DECISION" && (targetEntityType === "Proposal" || targetEntityType === "Tension")) ||
        (type === "PROPOSAL" && targetEntityType === "Tension")
      );
      const deliberationEntryType = isDeliberationEntry ? normalizeDeliberationEntryType(item.deliberationEntryType) : null;
      const modelDedupeKey = typeof item.dedupeKey === "string"
        ? normalizeMeetingProductTerminology(item.dedupeKey).trim().toLowerCase().replace(/\s+/g, "-").slice(0, 160)
        : "";
      const dedupeKey = modelDedupeKey || deterministicInsightDedupeKey({
        meetingId: meeting.id,
        type,
        operation,
        title,
        bodyMd,
        targetEntityType: keepTarget ? targetEntityType : null,
        targetEntityId: keepTarget ? targetEntityId : null,
        deliberationEntryType,
        resolutionOutcome,
      });
      if (seenDedupeKeys.has(dedupeKey)) continue;
      seenDedupeKeys.add(dedupeKey);

      const insightData = {
        meetingId: meeting.id,
        workspaceId: params.workspaceId,
        type,
        operation,
        status: "SUGGESTED" as const,
        title,
        bodyMd,
        assigneeHint: typeof item.assigneeHint === "string" ? item.assigneeHint.trim() || null : null,
        dueAt: type === "ACTION_ITEM" || type === "FOLLOW_UP" ? normalizeDueAt(item.dueAt ?? item.dueDate) : null,
        confidence: typeof item.confidence === "number" ? item.confidence : 0,
        sourceQuote: typeof item.sourceQuote === "string" ? normalizeMeetingProductTerminology(item.sourceQuote).slice(0, 200) : null,
        targetEntityType: keepTarget ? targetEntityType : null,
        targetEntityId: keepTarget ? targetEntityId : null,
        deliberationEntryType,
        resolutionOutcome,
        dedupeKey,
        sourceRecordId: latestSourceRecord?.id ?? null,
        sourceRecordedAt: latestSourceRecord?.recordedAt ?? meeting.recordedAt ?? null,
      };

      const existingInsight = await tx.meetingInsight.findFirst({
        where: {
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          OR: [
            { dedupeKey },
            {
              dedupeKey: null,
              type,
              operation,
              title,
              bodyMd,
              targetEntityType: insightData.targetEntityType,
              targetEntityId: insightData.targetEntityId,
              deliberationEntryType,
              resolutionOutcome,
            },
          ],
        },
        select: { id: true },
      });
      if (existingInsight) continue;

      const createdCount = await tx.meetingInsight.createMany({
        data: [insightData],
        skipDuplicates: true,
      });
      if (createdCount.count === 0) continue;

      const created = await tx.meetingInsight.findFirst({
        where: {
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          dedupeKey,
        },
        orderBy: { createdAt: "desc" },
      });
      if (created) {
        createdInsights.push(created);
        if (created.targetEntityType && created.targetEntityId && insightData.sourceRecordedAt) {
          await tx.meetingInsight.updateMany({
            where: {
              workspaceId: params.workspaceId,
              id: { not: created.id },
              status: "SUGGESTED",
              targetEntityType: created.targetEntityType,
              targetEntityId: created.targetEntityId,
              supersededAt: null,
              OR: [
                { sourceRecordedAt: null },
                { sourceRecordedAt: { lt: insightData.sourceRecordedAt } },
              ],
            },
            data: {
              supersededAt: new Date(),
              supersededByInsightId: created.id,
            },
          });
        }
      }
    }

    await tx.meeting.update({
      where: { id: meeting.id },
      data: { aiProcessedAt: new Date() },
    });

    return createdInsights;
  });
}

export async function confirmInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "SUGGESTED", 400, "INVALID_STATE", "Insight is not in SUGGESTED state.");

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "CONFIRMED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}

export async function updateInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string; title?: string | null; bodyMd?: string | null; assigneeHint?: string | null; dueAt?: Date | string | null }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only reviewable insights can be edited.");

  const title = params.title?.trim();
  const bodyMd = params.bodyMd?.trim();
  const assigneeHint = params.assigneeHint?.trim();
  const dueAt = params.dueAt === undefined ? undefined : normalizeDueAt(params.dueAt);
  invariant(title === undefined || title.length > 0, 400, "INVALID_INPUT", "Insight title is required.");
  
  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(bodyMd !== undefined ? { bodyMd } : {}),
      ...(params.assigneeHint !== undefined ? { assigneeHint: assigneeHint || null } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}

export async function dismissInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "DISMISSED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}

export async function applyInsight(
  actor: AppActor,
  params: { workspaceId: string; insightId: string; autoApplied?: boolean }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const insight = await prisma.meetingInsight.findUnique({
    where: { id: params.insightId, workspaceId: params.workspaceId },
    include: { meeting: true },
  });

  invariant(insight, 404, "NOT_FOUND", "Insight not found.");
  invariant(insight.status === "CONFIRMED" || insight.status === "SUGGESTED", 400, "INVALID_STATE", "Insight must be suggested or confirmed before applying.");

  let appliedEntityType: string | null = null;
  let appliedEntityId: string | null = null;

  const meetingContext = `*Created from meeting:* [${insight.meeting.title || "Untitled"}](/workspaces/${params.workspaceId}/meetings/${insight.meetingId})`;
  const humanBody = stripMeetingBlockContext(insight.bodyMd);
  const fullBody = [humanBody, meetingContext].filter(Boolean).join("\n\n");

  if (insight.type === "DELIBERATION_ENTRY") {
    invariant(insight.targetEntityType === "Proposal" || insight.targetEntityType === "Tension", 400, "INVALID_STATE", "Deliberation insights must point to a proposal or tension.");
    invariant(insight.targetEntityId, 400, "INVALID_STATE", "Deliberation insights must point to a target record.");

    const parentType = insight.targetEntityType === "Proposal" ? "PROPOSAL" : "TENSION";
    if (insight.targetEntityType === "Proposal") {
      const proposal = await prisma.proposal.findFirst({
        where: {
          id: insight.targetEntityId,
          workspaceId: params.workspaceId,
          archivedAt: null,
        },
        select: { id: true },
      });
      invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
    } else {
      const tension = await prisma.tension.findFirst({
        where: {
          id: insight.targetEntityId,
          workspaceId: params.workspaceId,
          archivedAt: null,
        },
        select: { id: true },
      });
      invariant(tension, 404, "NOT_FOUND", "Tension not found.");
    }

    const entry = await postDeliberationEntry(actor, {
      workspaceId: params.workspaceId,
      parentType,
      parentId: insight.targetEntityId,
      entryType: normalizeDeliberationEntryType(insight.deliberationEntryType),
      bodyMd: fullBody,
    });
    appliedEntityType = "DeliberationEntry";
    appliedEntityId = entry.id;
  } else if (insight.operation === "RESOLVE") {
    invariant(insight.targetEntityType && insight.targetEntityId, 400, "INVALID_STATE", "Resolved insight must point to a target record.");

    if (insight.targetEntityType === "Action") {
      await updateAction(actor, {
        workspaceId: params.workspaceId,
        actionId: insight.targetEntityId,
        status: "COMPLETED",
      });
      appliedEntityType = "Action";
      appliedEntityId = insight.targetEntityId;
    } else if (insight.targetEntityType === "Tension") {
      await updateTension(actor, {
        workspaceId: params.workspaceId,
        tensionId: insight.targetEntityId,
        status: "RESOLVED",
        resolvedVia: `Meeting: ${insight.meeting.title || insight.meetingId}`,
      });
      appliedEntityType = "Tension";
      appliedEntityId = insight.targetEntityId;
    } else if (insight.targetEntityType === "Proposal") {
      const outcome = (insight.resolutionOutcome || "ADOPTED") as ProposalResolutionOutcome;
      await resolveProposal(actor, {
        workspaceId: params.workspaceId,
        proposalId: insight.targetEntityId,
        outcome,
        decisionMd: fullBody,
      });
      appliedEntityType = "Proposal";
      appliedEntityId = insight.targetEntityId;
    }
  } else if (insight.type === "DECISION") {
    appliedEntityType = "Decision";
    
    const existing = insight.meeting.decisionsJson as { items: any[] } | null;
    const items = Array.isArray(existing?.items) ? existing.items : [];
    items.push({
      title: insight.title,
      bodyMd: humanBody,
      confirmedAt: new Date().toISOString(),
    });

    await prisma.meeting.update({
      where: { id: insight.meetingId },
      data: { decisionsJson: { items } }
    });
  } else {
    // Attempt fuzzy match for a member reference if a hint exists.
    let hintedMemberId: string | null = null;
    if (insight.assigneeHint) {
      const mems = await prisma.member.findMany({
        where: { workspaceId: params.workspaceId },
        include: { user: true }
      });
      const lowHint = insight.assigneeHint.toLowerCase();
      const match = mems.find((m: { id: string; user: { displayName?: string | null; email: string } }) =>
        m.user.displayName?.toLowerCase().includes(lowHint) ||
        m.user.email.toLowerCase().includes(lowHint)
      );
      if (match) hintedMemberId = match.id;
    }

    if (insight.type === "ACTION_ITEM" || insight.type === "FOLLOW_UP") {
      const action = await createAction(actor, {
        workspaceId: params.workspaceId,
        title: insight.title,
        bodyMd: fullBody,
        assigneeMemberId: hintedMemberId,
        dueAt: insight.dueAt ?? null,
        isPrivate: false,
      });
      const opened = await updateAction(actor, {
        workspaceId: params.workspaceId,
        actionId: action.id,
        status: "OPEN",
      });
      appliedEntityType = "Action";
      appliedEntityId = opened.id;
    } else if (insight.type === "TENSION") {
      const tension = await createTension(actor, {
        workspaceId: params.workspaceId,
        title: insight.title,
        bodyMd: fullBody,
        raisedByMemberId: hintedMemberId,
        meetingId: insight.meetingId,
        isPrivate: false,
      });
      const opened = await updateTension(actor, {
        workspaceId: params.workspaceId,
        tensionId: tension.id,
        status: "OPEN",
      });
      appliedEntityType = "Tension";
      appliedEntityId = opened.id;
    } else if (insight.type === "PROPOSAL") {
      const proposal = insight.targetEntityType === "Tension" && insight.targetEntityId
        ? await createProposalFromTension(actor, {
          workspaceId: params.workspaceId,
          sourceTensionId: insight.targetEntityId,
          title: insight.title,
          bodyMd: fullBody,
          meetingId: insight.meetingId,
          isPrivate: false,
        })
        : await createProposal(actor, {
          workspaceId: params.workspaceId,
          title: insight.title,
          bodyMd: fullBody,
          meetingId: insight.meetingId,
          isPrivate: false,
        });
      await submitProposal(actor, {
        workspaceId: params.workspaceId,
        proposalId: proposal.id,
      });
      appliedEntityType = "Proposal";
      appliedEntityId = proposal.id;
    }
  }

  return prisma.meetingInsight.update({
    where: { id: params.insightId },
    data: {
      status: "APPLIED",
      appliedEntityType,
      appliedEntityId,
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
      autoAppliedAt: params.autoApplied ? new Date() : null,
      autoApplyError: null,
    },
  });
}

export async function autoApplyMeetingInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string; confidenceThreshold?: number }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const confidenceThreshold = params.confidenceThreshold ?? AUTO_APPLY_CONFIDENCE_THRESHOLD;
  const insights = await prisma.meetingInsight.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ["SUGGESTED", "CONFIRMED"] },
      confidence: { gte: confidenceThreshold },
    },
    orderBy: { createdAt: "asc" },
  });

  let applied = 0;
  let failed = 0;
  let skipped = 0;
  const bypassSlackReviewedActionItems = await shouldBypassAutoApplyForSlackMeetingActionReview({
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
  });

  for (const insight of insights) {
    const requiredThreshold = Math.max(confidenceThreshold, autoApplyThresholdForInsight(insight));
    if ((insight.confidence ?? 0) < requiredThreshold) {
      skipped++;
      continue;
    }
    if (insight.operation === "RESOLVE" && (!insight.targetEntityType || !insight.targetEntityId)) {
      skipped++;
      continue;
    }
    if (insight.type === "DELIBERATION_ENTRY" && (!insight.targetEntityType || !insight.targetEntityId)) {
      skipped++;
      continue;
    }
    if (!hasMeetingEvidenceForAutoApply(insight)) {
      skipped++;
      continue;
    }
    if (bypassSlackReviewedActionItems && insight.type === "ACTION_ITEM" && insight.operation === "CREATE") {
      skipped++;
      continue;
    }

    try {
      await applyInsight(actor, {
        workspaceId: params.workspaceId,
        insightId: insight.id,
        autoApplied: true,
      });
      applied++;
    } catch (error) {
      failed++;
      await prisma.meetingInsight.update({
        where: { id: insight.id },
        data: {
          autoApplyError: error instanceof Error ? error.message : "Failed to auto-apply insight.",
        },
      });
    }
  }

  return { applied, failed, skipped, threshold: confidenceThreshold };
}

export async function confirmAllInsights(
  actor: AppActor,
  params: { workspaceId: string; meetingId: string; onlyType?: MeetingInsightType }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const updateWhere: Prisma.MeetingInsightWhereInput = {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    status: "SUGGESTED",
  };
  if (params.onlyType) {
    updateWhere.type = params.onlyType;
  }

  await prisma.meetingInsight.updateMany({
    where: updateWhere,
    data: {
      status: "CONFIRMED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
}
