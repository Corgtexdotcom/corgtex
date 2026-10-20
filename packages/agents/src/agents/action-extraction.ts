import type { AgentTriggerType } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, captureReadableDigestInputs, invariant, isArtifactInputProofReadable,
  meetingTranscriptInputProjection, mergeArtifactInputProofs, scanSourceReadableRecords, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun, type AgentOutcome } from "../runtime";

type ExtractionContext = { meeting: { id: string; title: string | null; transcript: string | null } | null;
  suggested: number; lineageRoots: LineageRoot[] };

export async function runActionExtractionAgent(params: {
  workspaceId: string;
  triggerRef: string;
  meetingId: string;
  triggerType?: AgentTriggerType;
  lineageActor?: AppActor;
}) {
  const actor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "action-extraction", workspaceIds: [params.workspaceId] };
  const planRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]);
  return executeAgentRun<{ meetingId: string }, ExtractionContext>({
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true,
    contextLineageRoots: context => context.lineageRoots,
    agentKey: "action-extraction",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Keep transcript insights as reviewable drafts until a person approves them.",
    payload: { meetingId: params.meetingId },
    plan: ["load-context", "load-insights", "queue-human-review"],
    buildContext: (helpers) => helpers.tool("meeting.load", { meetingId: params.meetingId }, async () => {
      const currentPlanRoots = mergeArtifactInputProofs(planRoots,
        await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Workspace", id: params.workspaceId }]));
      const row = await prisma.meeting.findFirst({ where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null } });
      if (!row) return { meeting: null, suggested: 0, lineageRoots: currentPlanRoots };
      const transcript = meetingTranscriptInputProjection(row);
      const transcriptRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "MeetingTranscript", id: row.id, snapshot: transcript }]);
      const insights = await scanSourceReadableRecords({ actor, workspaceId: params.workspaceId, kind: "MeetingInsight", load: (afterId, take) => prisma.meetingInsight.findMany({
        where: { workspaceId: params.workspaceId, meetingId: row.id, status: { in: ["SUGGESTED", "CONFIRMED"] },
          supersededAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
      }) });
      const captured = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "MeetingInsight", records: insights });
      // Generated legacy summary/blocks and raw insight text never enter this count-only context.
      return { meeting: { id: row.id, title: row.title, transcript: row.transcript }, suggested: captured.records.length,
        lineageRoots: mergeArtifactInputProofs(currentPlanRoots, transcriptRoots, captured.roots) };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers): Promise<AgentOutcome> => {
      const roots = mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]);
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Extraction inputs changed before review.");
      const lineageReceipt = await helpers.captureInputs(roots);
      if (!context.meeting) return { lineageReceipt, resultJson: { skipped: true, reason: "missing_meeting" } };
      if (!context.meeting.transcript?.trim()) return { lineageReceipt,
        resultJson: { skipped: true, reason: "missing_transcript", meetingId: context.meeting.id } };
      return { lineageReceipt, resultJson: { meetingId: context.meeting.id, reviewRequired: true, suggested: context.suggested } };
    },
  });
}
