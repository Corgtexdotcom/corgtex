import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runConstitutionSynthesisAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "constitution-synthesis",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Synthesize current policy corpus into an updated constitution document.",
    payload: {},
    plan: ["load-context", "synthesize-constitution", "persist-version"],
    buildContext: (helpers) => helpers.tool("policy.load-corpus", {}, async () => {
      const [policies, currentConstitution] = await Promise.all([
        prisma.policyCorpus.findMany({
          where: { workspaceId: params.workspaceId },
          include: {
            proposal: { select: { id: true, title: true } },
            circle: { select: { id: true, name: true } },
          },
          orderBy: { acceptedAt: "asc" },
        }),
        prisma.constitution.findFirst({
          where: { workspaceId: params.workspaceId },
          orderBy: { version: "desc" },
        }),
      ]);

      return {
        policies,
        currentConstitution: currentConstitution ? {
          version: currentConstitution.version,
          bodyMd: currentConstitution.bodyMd,
          createdAt: currentConstitution.createdAt,
        } : null,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const policies = Array.isArray(context.policies) ? context.policies : [];
      const currentConstitution = context.currentConstitution as {
        version: number;
        bodyMd: string;
        createdAt: string | Date;
      } | null;

      if (policies.length === 0) {
        return {
          resultJson: {
            skipped: true,
            reason: "no_policies",
          },
        };
      }

      const synthesized = await helpers.tool("model.chat", { policyCount: policies.length }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: `You are a governance document synthesizer for a self-managing organization. Your task is to create or update a 10-point constitution document. First and foremost, the constitution MUST preserve its fixed Mission, Vision, and Purpose exactly as they are defined in the provided organizational context or the current constitution (if updating).

The 10 points should be generated ad hoc based on the most up-to-date and important parts of the organization's decisions and direction. Extract this context from the accepted policy corpus and any available internal sources.

The constitution should:
- Start with the fixed section for Mission, Vision, and Purpose.
- Follow with exactly 10 distinct ad-hoc constitutional points representing key organizational principles/rules.
- Organize references and supplementary policies beneath these points where relevant.
- Reference source proposals for traceability.
- Be written in clear, authoritative markdown.

${currentConstitution ? "You are UPDATING the existing constitution. You MUST preserve the existing Mission, Vision, and Purpose exactly as written. Update the 10 points based on the new policies." : "You are creating the FIRST constitution version. Establish the 10 points from the provided context."}`,
          },
          {
            role: "user",
            content: JSON.stringify({
              currentConstitution: currentConstitution?.bodyMd ?? null,
              policies: policies.map((p: Record<string, unknown>) => ({
                title: p.title,
                bodyMd: p.bodyMd,
                circle: p.circle,
                proposal: p.proposal,
                acceptedAt: p.acceptedAt,
              })),
            }),
          },
        ],
      }));

      const diffSummary = currentConstitution
        ? await helpers.tool("model.chat", { purpose: "diff-summary" }, async () => defaultModelGateway.chat({ model,
            workspaceId: params.workspaceId,
            agentRunId: runId,
            taskType: "SUMMARY",
            messages: [
              {
                role: "system",
                content: "Summarize the key differences between the old and new constitution versions in 2-3 bullet points. Be specific about what changed.",
              },
              {
                role: "user",
                content: JSON.stringify({
                  previous: currentConstitution.bodyMd.slice(0, 2000),
                  updated: synthesized.content.slice(0, 2000),
                }),
              },
            ],
          }))
        : null;

      // Persist the new constitution version
      const latestVersion = currentConstitution?.version ?? 0;
      const newVersion = await helpers.step("persist-version", { version: latestVersion + 1 }, async () =>
        createConstitutionVersion({
          workspaceId: params.workspaceId,
          bodyMd: synthesized.content,
          diffSummary: diffSummary?.content ?? (currentConstitution ? null : "Initial constitution generated from policy corpus."),
          triggerType: "agent",
          triggerRef: runId,
          modelUsed: synthesized.usage?.model ?? "unknown",
          promptTokens: synthesized.usage?.inputTokens ?? null,
          completionTokens: synthesized.usage?.outputTokens ?? null,
        })
      );

      return {
        resultJson: {
          constitutionId: newVersion.id,
          version: newVersion.version,
          diffSummary: diffSummary?.content ?? null,
          policyCount: policies.length,
        },
      };
    },
  });
}

