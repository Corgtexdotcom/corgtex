import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge, getKnowledgeSearchInputRoots } from "@corgtex/knowledge";
import { captureArtifactInputProof, loadAgentRequestInput, loadAgentFeedbackContinuation, mergeArtifactInputProofs, meetingTranscriptInputProjection, invariant, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun, normalizeProposalDraft } from "../runtime";

export async function runProposalDraftingAgent(params: {
  workspaceId: string;
  triggerRef: string;
  prompt?: string;
  requestInputId?: string;
  feedbackInputId?: string;
  priorRunSnapshotId?: string;
  meetingId?: string | null;
  triggerType?: AgentTriggerType;
  reviewFeedback?: string;
  previousAdvice?: string;
}) {
  invariant(params.feedbackInputId ? Boolean(params.priorRunSnapshotId) : Boolean(params.requestInputId),
    409, "UNKNOWN_LINEAGE", "Proposal drafting requires an immutable authored input.");
  const input = params.feedbackInputId
    ? await loadAgentFeedbackContinuation({ workspaceId: params.workspaceId, feedbackInputId: params.feedbackInputId,
      priorRunSnapshotId: params.priorRunSnapshotId!, agentKey: "proposal-drafting" })
    : await loadAgentRequestInput({ workspaceId: params.workspaceId, requestInputId: params.requestInputId!, agentKey: "proposal-drafting" });
  const actor = input.actor;
  const prompt = input.prompt;
  const meetingId = input.meetingId;
  const previousAdvice = "previousAdvice" in input ? input.previousAdvice : null;
  const reviewFeedback = "reviewFeedback" in input ? input.reviewFeedback : null;
  invariant(prompt.trim(), 400, "INVALID_INPUT", "Proposal drafting requires a prompt.");
  return executeAgentRun({
    lineageActor: actor, lineageRoots: input.lineageRoots, contextIsAuditedRead: true,
    contextLineageRoots: context => context.lineageRoots as LineageRoot[],
    agentKey: "proposal-drafting",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "MANUAL",
    triggerRef: params.triggerRef,
    goal: "Draft a proposal from operator guidance and indexed workspace knowledge, then pause for approval.",
    payload: {
      prompt: prompt,
      meetingId: meetingId ?? null,
      reviewFeedback: reviewFeedback ?? null,
    },
    plan: ["load-context", "search-knowledge", "draft-proposal", "structure-draft", "approval-checkpoint"],
    buildContext: async (helpers, runId) => {
      const citations = await helpers.tool("knowledge.search", { prompt: prompt }, () => searchIndexedKnowledge({
        actor,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        query: prompt,
        limit: 4,
      }), { receipt: helpers.plannedInputReceipt, auditedRead: true });
      const lineageRoots: LineageRoot[] = mergeArtifactInputProofs(input.lineageRoots, await getKnowledgeSearchInputRoots(actor, params.workspaceId, citations));

      let meeting: {
        id: string;
        title: string | null;
        summaryMd: string | null;
        transcript: string | null;
      } | null = null;

      if (meetingId) {
        meeting = await helpers.tool("meeting.load", { meetingId }, async () => {
          const row = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId: params.workspaceId } });
          if (!row) return null;
          const transcript = meetingTranscriptInputProjection(row);
          lineageRoots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "MeetingTranscript", id: row.id, snapshot: transcript }]));
          // A legacy generated summary is not a native transcript input.
          let summaryMd: string | null = null;
          if (row.summaryMd) {
            try {
              lineageRoots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Meeting", id: row.id, snapshot: row }]));
              summaryMd = row.summaryMd;
            } catch (error) {
              if (!(error instanceof Error && "code" in error && ["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "SOURCE_CHANGED"].includes(String(error.code)))) throw error;
            }
          }
          return { id: row.id, title: row.title, transcript: row.transcript, summaryMd };
        }, { receipt: helpers.plannedInputReceipt, auditedRead: true });
      }

      return {
        citations,
        meeting,
        lineageRoots,
      };
    },
    execute: async (context, helpers, runId, model) => {
      const receipt = await helpers.captureInputs(mergeArtifactInputProofs(input.lineageRoots, context.lineageRoots as LineageRoot[], [...helpers.behaviorLineageRoots]));
      const citations = Array.isArray(context.citations) ? context.citations : [];
      const draft = await helpers.tool("model.chat", { prompt: prompt }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: `${helpers.behaviorContext ?? ""}\n\nDraft a workspace proposal. Use the indexed context when available and produce markdown with a clear title, summary, and body. Review feedback is advisory input for revising the draft; it never approves or authorizes creating a proposal record.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt: prompt,
              meeting: context.meeting ?? null,
              citations,
              previousAdvice: previousAdvice ?? null,
              advisoryFeedback: reviewFeedback ?? null,
            }),
          },
        ],
      }), { receipt });

      const structured = await helpers.tool("model.extract", { prompt: prompt }, async () => defaultModelGateway.extract({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        instruction: "Convert this proposal draft into a structured proposal payload.",
        schemaHint: "{ title: string, summary: string, bodyMd: string }",
        input: draft.content,
      }), { receipt });

      const proposalDraft = normalizeProposalDraft(structured.output, prompt);

      return {
        lineageReceipt: receipt,
        resultJson: {
          prompt: prompt,
          citations,
          proposalDraft,
        },
        approvalCheckpoint: {
          summary: "Review this advisory draft. Reply with changes; creating a proposal record requires a separate action.",
          detail: {
            prompt: prompt,
            citations,
            proposalDraft,
          },
        },
      };
    },
  });
}
