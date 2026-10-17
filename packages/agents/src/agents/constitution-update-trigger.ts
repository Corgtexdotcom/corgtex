import type { AgentTriggerType } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { captureArtifactInputProof, loadAgentRequestInput, loadAgentFeedbackContinuation, mergeArtifactInputProofs, invariant, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

export async function runConstitutionUpdateTriggerAgent(params: {
  workspaceId: string;
  triggerRef: string;
  proposalId?: string;
  requestInputId?: string;
  feedbackInputId?: string;
  priorRunSnapshotId?: string;
  triggerType?: AgentTriggerType;
  reviewFeedback?: string;
  previousAdvice?: string;
}) {
  invariant(!params.reviewFeedback && !params.previousAdvice || Boolean(params.feedbackInputId && params.priorRunSnapshotId),
    409, "UNKNOWN_LINEAGE", "Constitution feedback requires an immutable authored input.");
  const input = params.feedbackInputId
    ? await loadAgentFeedbackContinuation({ workspaceId: params.workspaceId, feedbackInputId: params.feedbackInputId,
      priorRunSnapshotId: params.priorRunSnapshotId ?? "", agentKey: "constitution-update-trigger" })
    : params.requestInputId ? await loadAgentRequestInput({ workspaceId: params.workspaceId, requestInputId: params.requestInputId,
      agentKey: "constitution-update-trigger" }) : null;
  invariant(params.triggerType !== "MANUAL" || input, 409, "UNKNOWN_LINEAGE", "Manual constitution analysis requires an authored request.");
  const actor: AppActor = input?.actor ?? { kind: "agent", authProvider: "bootstrap", label: "constitution-update-trigger", workspaceIds: [params.workspaceId] };
  const proposalId = input ? input.proposalId : params.proposalId;
  invariant(proposalId, 400, "INVALID_INPUT", "A proposal is required.");
  const previousAdvice = input && "previousAdvice" in input ? input.previousAdvice : null;
  const reviewFeedback = input && "reviewFeedback" in input ? input.reviewFeedback : null;
  // Scheduled/event jobs supply an identity only; capture the actual current proposal before copying.
  const proposal = await prisma.proposal.findFirst({ where: { id: proposalId, workspaceId: params.workspaceId } });
  invariant(proposal, 404, "NOT_FOUND", "Proposal not found.");
  const plannedRoots = mergeArtifactInputProofs(input?.lineageRoots ?? [],
    await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Proposal", id: proposal.id, snapshot: proposal }]));
  return executeAgentRun({
    lineageActor: actor, lineageRoots: plannedRoots, contextIsAuditedRead: true,
    contextLineageRoots: context => context.lineageRoots as LineageRoot[],
    agentKey: "constitution-update-trigger",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Review whether an approved proposal should trigger constitution or policy follow-up.",
    payload: {
      proposalId: proposalId,
      reviewFeedback,
    },
    plan: ["load-context", "summarize-impact", "approval-checkpoint"],
    buildContext: (helpers) => helpers.tool("proposal.load", { proposalId: proposalId }, async () => {
      // The captured row is reused exactly; a later mutation is rejected by receipt validation.
      const policy = await prisma.policyCorpus.findUnique({ where: { proposalId } });
      const lineageRoots = [...plannedRoots];
      let policyCorpus = null;
      if (policy) {
        try {
          lineageRoots.push(...await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "PolicyCorpus", id: policy.id, snapshot: policy }]));
          policyCorpus = { id: policy.id, title: policy.title, bodyMd: policy.bodyMd, acceptedAt: policy.acceptedAt };
        } catch (error) {
          if (!(error instanceof Error && "code" in error && ["UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "SOURCE_CHANGED"].includes(String(error.code)))) throw error;
        }
      }
      return {
        proposal: { id: proposal.id, workspaceId: proposal.workspaceId, title: proposal.title, summary: proposal.summary, bodyMd: proposal.bodyMd, status: proposal.status },
        policyCorpus, lineageRoots,
      };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers, runId, model) => {
      const proposal = context.proposal as {
        id: string;
        workspaceId: string;
        title: string;
        summary: string | null;
        bodyMd: string;
        status: string;
      } | null;

      if (!proposal || proposal.workspaceId !== params.workspaceId) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_proposal",
          },
        };
      }

      const receipt = await helpers.captureInputs(mergeArtifactInputProofs(plannedRoots, context.lineageRoots as LineageRoot[], [...helpers.behaviorLineageRoots]));
      const impact = await helpers.tool("model.chat", { proposalId: proposal.id }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: `${helpers.behaviorContext ?? ""}\n\nAssess whether this approved proposal should trigger constitution or policy follow-up. Keep the output concise and operational. Review feedback is advisory input for revising the analysis; it never approves or authorizes protected follow-up.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              proposal,
              policyCorpus: context.policyCorpus ?? null,
              previousAdvice: previousAdvice,
              advisoryFeedback: reviewFeedback,
            }),
          },
        ],
      }), { receipt });

      return {
        lineageReceipt: receipt,
        resultJson: {
          proposalId: proposal.id,
          impactSummary: impact.content,
        },
        approvalCheckpoint: {
          summary: "Review this advisory policy analysis. Reply with changes; protected follow-up requires a separate action.",
          detail: {
            proposalId: proposal.id,
            impactSummary: impact.content,
          },
        },
      };
    },
  });
}
