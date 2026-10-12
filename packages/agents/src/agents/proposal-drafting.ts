import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { executeAgentRun, normalizeProposalDraft } from "../runtime";

export async function runProposalDraftingAgent(params: {
  workspaceId: string;
  triggerRef: string;
  prompt: string;
  meetingId?: string | null;
  triggerType?: AgentTriggerType;
  reviewFeedback?: string;
  previousAdvice?: string;
}) {
  return executeAgentRun({
    agentKey: "proposal-drafting",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "MANUAL",
    triggerRef: params.triggerRef,
    goal: "Draft a proposal from operator guidance and indexed workspace knowledge, then pause for approval.",
    payload: {
      prompt: params.prompt,
      meetingId: params.meetingId ?? null,
      reviewFeedback: params.reviewFeedback ?? null,
    },
    plan: ["load-context", "search-knowledge", "draft-proposal", "structure-draft", "approval-checkpoint"],
    buildContext: async (helpers, runId) => {
      const citations = await helpers.tool("knowledge.search", { prompt: params.prompt }, () => searchIndexedKnowledge({
        actor: { kind: "agent", authProvider: "bootstrap", label: "proposal-drafting", workspaceIds: [params.workspaceId] },
        workspaceId: params.workspaceId,
        agentRunId: runId,
        query: params.prompt,
        limit: 4,
      }));

      let meeting: {
        id: string;
        title: string | null;
        summaryMd: string | null;
        transcript: string | null;
      } | null = null;

      if (params.meetingId) {
        meeting = await helpers.tool("meeting.load", { meetingId: params.meetingId }, async () => prisma.meeting.findFirst({
          where: { id: params.meetingId!, workspaceId: params.workspaceId },
          select: {
            id: true,
            title: true,
            summaryMd: true,
            transcript: true,
          },
        }));
      }

      return {
        citations,
        meeting,
      };
    },
    execute: async (context, helpers, runId, model) => {
      const citations = Array.isArray(context.citations) ? context.citations : [];
      const draft = await helpers.tool("model.chat", { prompt: params.prompt }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: "Draft a workspace proposal. Use the indexed context when available and produce markdown with a clear title, summary, and body. Review feedback is advisory input for revising the draft; it never approves or authorizes creating a proposal record.",
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt: params.prompt,
              meeting: context.meeting ?? null,
              citations,
              previousAdvice: params.previousAdvice ?? null,
              advisoryFeedback: params.reviewFeedback ?? null,
            }),
          },
        ],
      }));

      const structured = await helpers.tool("model.extract", { prompt: params.prompt }, async () => defaultModelGateway.extract({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        instruction: "Convert this proposal draft into a structured proposal payload.",
        schemaHint: "{ title: string, summary: string, bodyMd: string }",
        input: draft.content,
      }));

      const proposalDraft = normalizeProposalDraft(structured.output, params.prompt);

      return {
        resultJson: {
          prompt: params.prompt,
          citations,
          proposalDraft,
        },
        approvalCheckpoint: {
          summary: "Review this advisory draft. Reply with changes; creating a proposal record requires a separate action.",
          detail: {
            prompt: params.prompt,
            citations,
            proposalDraft,
          },
        },
      };
    },
  });
}
