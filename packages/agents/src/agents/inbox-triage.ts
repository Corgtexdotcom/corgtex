import type { AgentTriggerType } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { captureArtifactInputProof, captureReadableDigestInputs, invariant, isArtifactInputProofReadable,
  mergeArtifactInputProofs, scanSourceReadableRecords, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

type InboxContext = { openActions: number; openTensions: number; submittedProposals: number; lineageRoots: LineageRoot[] };

export async function runInboxTriageAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
  lineageActor?: AppActor;
}) {
  const actor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "inbox-triage", workspaceIds: [params.workspaceId] };
  const planRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]);
  return executeAgentRun<Record<string, never>, InboxContext>({
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true,
    contextLineageRoots: context => context.lineageRoots,
    agentKey: "inbox-triage",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Triage workspace inbox and summarize current operating state.",
    payload: {},
    plan: ["load-context", "summarize-inbox"],
    buildContext: (helpers) => helpers.tool("workspace.snapshot", {}, async () => {
      const workspaceRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]);
      const [actions, tensions, proposals] = await Promise.all([
        scanSourceReadableRecords({ actor, workspaceId: params.workspaceId, kind: "Action", load: (afterId, take) => prisma.action.findMany({
          where: { workspaceId: params.workspaceId, archivedAt: null, status: { in: ["OPEN", "IN_PROGRESS"] }, ...(afterId ? { id: { gt: afterId } } : {}) },
          orderBy: { id: "asc" }, take,
        }) }),
        scanSourceReadableRecords({ actor, workspaceId: params.workspaceId, kind: "Tension", load: (afterId, take) => prisma.tension.findMany({
          where: { workspaceId: params.workspaceId, archivedAt: null, status: "OPEN", ...(afterId ? { id: { gt: afterId } } : {}) },
          orderBy: { id: "asc" }, take,
        }) }),
        scanSourceReadableRecords({ actor, workspaceId: params.workspaceId, kind: "Proposal", load: (afterId, take) => prisma.proposal.findMany({
          where: { workspaceId: params.workspaceId, archivedAt: null, status: "OPEN", ...(afterId ? { id: { gt: afterId } } : {}) },
          orderBy: { id: "asc" }, take,
        }) }),
      ]);
      const captures = await Promise.all([
        captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "Action", records: actions }),
        captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "Tension", records: tensions }),
        captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "Proposal", records: proposals }),
      ]);
      return { openActions: captures[0].records.length, openTensions: captures[1].records.length,
        submittedProposals: captures[2].records.length, lineageRoots: mergeArtifactInputProofs(planRoots, workspaceRoots, ...captures.map((capture) => capture.roots)) };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers, runId, model) => {
      const lineageRoots: LineageRoot[] = mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]);
      const revalidate = async () => invariant(await isArtifactInputProofReadable(actor, params.workspaceId, lineageRoots),
        409, "SOURCE_CHANGED", "Inbox inputs changed during generation.");
      await revalidate();
      const receipt = await helpers.captureInputs(lineageRoots);
      const metrics = { openActions: context.openActions, openTensions: context.openTensions, submittedProposals: context.submittedProposals };
      const summary = await helpers.tool("model.chat", { purpose: "workspace-triage" }, async () => {
        await revalidate();
        return defaultModelGateway.chat({ model,
          workspaceId: params.workspaceId, agentRunId: runId, taskType: "AGENT",
          messages: [
            { role: "system", content: `${helpers.behaviorContext ?? ""}\n\nSummarize the workspace operating state for an internal operator inbox.` },
            { role: "user", content: JSON.stringify(metrics) },
          ],
        });
      }, { receipt });
      await revalidate();
      return { lineageReceipt: receipt, resultJson: { summary: summary.content, metrics } };
    },
  });
}
