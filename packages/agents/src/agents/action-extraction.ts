import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runActionExtractionAgent(params: {
  workspaceId: string;
  triggerRef: string;
  meetingId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "action-extraction",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Extract proposed action items, structural proposals, and tensions from meeting content and pause for approval before creating records.",
    payload: {
      meetingId: params.meetingId,
    },
    plan: ["load-context", "extract-actions", "approval-checkpoint"],
    buildContext: (helpers) => helpers.tool("meeting.load", { meetingId: params.meetingId }, async () => prisma.meeting.findUnique({
      where: { id: params.meetingId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        transcript: true,
        summaryMd: true,
      },
    }).then((meeting) => ({
      meeting,
    }))),
    execute: async (context, helpers, runId, model) => {
      const meeting = context.meeting as {
        id: string;
        workspaceId: string;
        title: string | null;
        transcript: string | null;
        summaryMd: string | null;
      } | null;

      if (!meeting || meeting.workspaceId !== params.workspaceId) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_meeting",
          },
        };
      }

      const extracted = await helpers.tool("model.extract", { meetingId: meeting.id }, async () => defaultModelGateway.extract({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        instruction: "Extract concrete follow-up actions, systemic tensions, and structural proposals (e.g. role changes or new accountabilities) discussed in this meeting.",
        schemaHint: "{ actions: [{ title: string, rationale: string }], tensions: [{ title: string, description: string }], proposals: [{ title: string, type: string, description: string }] }",
        input: JSON.stringify({
          title: meeting.title,
          summary: meeting.summaryMd,
          transcript: meeting.transcript,
        }),
      }));

      const proposedActions = normalizeActionDrafts(extracted.output?.actions || []);
      const proposedTensions = Array.isArray(extracted.output?.tensions) ? extracted.output.tensions : [];
      const structuralProposals = Array.isArray(extracted.output?.proposals) ? extracted.output.proposals : [];

      return {
        resultJson: {
          meetingId: meeting.id,
          proposedActions,
          proposedTensions,
          structuralProposals,
        },
        approvalCheckpoint: {
          summary: "Review extracted actions, tensions, and structural proposals before creating records.",
          detail: {
            meetingId: meeting.id,
            proposedActions,
            proposedTensions,
            structuralProposals,
          },
        },
      };
    },
  });
}

