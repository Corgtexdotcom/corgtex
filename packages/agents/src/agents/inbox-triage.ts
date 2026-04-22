import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runInboxTriageAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "inbox-triage",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Triage workspace inbox and summarize current operating state.",
    payload: {},
    plan: ["load-context", "summarize-inbox"],
    buildContext: (helpers) => helpers.tool("workspace.snapshot", {}, async () => {
      const [openActions, openTensions, submittedProposals] = await Promise.all([
        prisma.action.count({
          where: {
            workspaceId: params.workspaceId,
            status: {
              in: ["OPEN", "IN_PROGRESS"],
            },
          },
        }),
        prisma.tension.count({
          where: {
            workspaceId: params.workspaceId,
            status: {
              in: ["OPEN", "IN_PROGRESS"],
            },
          },
        }),
        prisma.proposal.count({
          where: {
            workspaceId: params.workspaceId,
            status: "SUBMITTED",
          },
        }),
      ]);

      return {
        openActions,
        openTensions,
        submittedProposals,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const summary = await helpers.tool("model.chat", { purpose: "workspace-triage" }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: "Summarize the workspace operating state for an internal operator inbox.",
          },
          {
            role: "user",
            content: JSON.stringify(context),
          },
        ],
      }));

      return {
        resultJson: {
          summary: summary.content,
          metrics: context,
        },
      };
    },
  });
}

