import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { createConstitutionVersion, loadConstitutionCorpusSnapshot } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

function parseConstitutionSynthesis(content: string, policyIds: Set<string>) {
  let value: unknown;
  try {
    value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error("Invalid Constitution synthesis output.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Constitution synthesis output.");
  }
  if (Object.keys(value).some((key) => key !== "bodyMd" && key !== "pointSources")) {
    throw new Error("Invalid Constitution synthesis output.");
  }
  const { bodyMd, pointSources } = value as Record<string, unknown>;
  if (typeof bodyMd !== "string" || !bodyMd.trim() || !Array.isArray(pointSources) || pointSources.length !== 10) {
    throw new Error("Invalid Constitution synthesis output.");
  }
  const headings = [...bodyMd.matchAll(/^##\s+(\d+)\.\s+\S/gm)].map((match) => Number(match[1]));
  if (headings.length !== 10 || headings.some((pointOrder, index) => pointOrder !== index + 1)) {
    throw new Error("Invalid Constitution point order.");
  }

  const references: Array<{ pointOrder: number; sourceOrder: number; policyCorpusId: string; sourceKind: "PROPOSAL" }> = [];
  for (const [index, entry] of pointSources.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid Constitution source mapping.");
    }
    if (Object.keys(entry).some((key) => key !== "pointOrder" && key !== "policyCorpusIds")) {
      throw new Error("Invalid Constitution source mapping.");
    }
    const { pointOrder, policyCorpusIds } = entry as Record<string, unknown>;
    if (pointOrder !== index + 1 || !Array.isArray(policyCorpusIds)) {
      throw new Error("Invalid Constitution source mapping.");
    }
    const seenPolicies = new Set<string>();
    for (const [sourceIndex, policyId] of policyCorpusIds.entries()) {
      if (typeof policyId !== "string" || !policyIds.has(policyId) || seenPolicies.has(policyId)) {
        throw new Error("Invalid Constitution source mapping.");
      }
      seenPolicies.add(policyId);
      references.push({ pointOrder: index + 1, sourceOrder: sourceIndex + 1, policyCorpusId: policyId, sourceKind: "PROPOSAL" });
    }
  }
  if (references.length === 0) throw new Error("Constitution synthesis must cite accepted policies.");
  return { bodyMd, references };
}

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
      const [corpusSnapshot, currentConstitution] = await Promise.all([
        loadConstitutionCorpusSnapshot(prisma, params.workspaceId),
        prisma.constitution.findFirst({
          where: { workspaceId: params.workspaceId },
          orderBy: { version: "desc" },
        }),
      ]);

      return {
        policies: corpusSnapshot.corpus,
        corpusFingerprint: corpusSnapshot.fingerprint,
        currentConstitution: currentConstitution ? {
          version: currentConstitution.version,
          bodyMd: currentConstitution.bodyMd,
          createdAt: currentConstitution.createdAt,
        } : null,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const policies = Array.isArray(context.policies) ? context.policies : [];
      const corpusFingerprint = typeof context.corpusFingerprint === "string"
        ? context.corpusFingerprint
        : null;
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
      if (!corpusFingerprint || !/^[a-f0-9]{64}$/i.test(corpusFingerprint)) {
        throw new Error("Constitution synthesis requires a verified policy corpus fingerprint.");
      }
      const policyIds = policies.map((policy) => (policy as { id?: unknown }).id);
      if (!policyIds.every((id): id is string => typeof id === "string" && !!id.trim())) {
        throw new Error("Constitution synthesis requires exact accepted policy IDs.");
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

Return only a JSON object with bodyMd and pointSources. In bodyMd, use exactly ten numbered headings from "## 1. ..." through "## 10. ..." after the fixed Mission, Vision, and Purpose section. pointSources must contain one entry for each point, in order: { "pointOrder": 1, "policyCorpusIds": ["an exact policy id"] }. Cite only accepted policy IDs supplied below that directly support the point. An unsupported point may have an empty list. Never invent source IDs or include proposal or tension details in this mapping.

${currentConstitution ? "You are UPDATING the existing constitution. You MUST preserve the existing Mission, Vision, and Purpose exactly as written. Update the 10 points based on the new policies." : "You are creating the FIRST constitution version. Establish the 10 points from the provided context."}`,
          },
          {
            role: "user",
            content: JSON.stringify({
              currentConstitution: currentConstitution?.bodyMd ?? null,
              policies: policies.map((p: Record<string, unknown>) => ({
                id: p.id,
                title: p.title,
                bodyMd: p.bodyMd,
                acceptedAt: p.acceptedAt,
              })),
            }),
          },
        ],
      }));

      const { bodyMd, references } = parseConstitutionSynthesis(
        synthesized.content,
        new Set(policyIds),
      );

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
                  updated: bodyMd.slice(0, 2000),
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
          bodyMd,
          references,
          diffSummary: diffSummary?.content ?? (currentConstitution ? null : "Initial constitution generated from policy corpus."),
          triggerType: "agent",
          triggerRef: runId,
          modelUsed: synthesized.usage?.model ?? "unknown",
          promptTokens: synthesized.usage?.inputTokens ?? null,
          completionTokens: synthesized.usage?.outputTokens ?? null,
          expectedCorpusFingerprint: corpusFingerprint,
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
