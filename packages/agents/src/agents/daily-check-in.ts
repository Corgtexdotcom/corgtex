import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, createCheckInGenerationActor, createDailyCompanyUnderstandingQuestions, invariant,
  isArtifactInputProofReadable, mergeArtifactInputProofs, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

type DailyQuestionContext = { memberId: string; lineageRoots: LineageRoot[] };

export async function runDailyCheckInAgent(params: {
  workspaceId: string;
  triggerRef: string;
  memberId: string;
  triggerType: "SCHEDULE" | "EVENT" | "MANUAL";
  lineageActor?: AppActor;
}) {
  const actor: AppActor = params.lineageActor ?? createCheckInGenerationActor(params.workspaceId, params.memberId);
  const member = await prisma.member.findFirst({ where: { id: params.memberId, workspaceId: params.workspaceId, isActive: true },
    include: { user: { select: { id: true, email: true, displayName: true } } } });
  invariant(member, 404, "NOT_FOUND", "Member not found.");
  const planRoots = await captureArtifactInputProof(actor, params.workspaceId, [
    { kind: "Workspace", id: params.workspaceId }, { kind: "Member", id: member.id, snapshot: member },
    { kind: "User", id: member.user.id, snapshot: member.user },
  ]);
  return executeAgentRun<{ memberId: string }, DailyQuestionContext>({
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true,
    contextLineageRoots: context => context.lineageRoots,
    agentKey: "daily-check-in",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType,
    triggerRef: params.triggerRef,
    goal: "Generate optional company-understanding questions that fill Brain evidence gaps.",
    payload: { memberId: member.id },
    plan: ["load-member-gaps", "dedupe-daily-questions", "persist-company-understanding-questions"],
    buildContext: (helpers) => helpers.tool("member.load", { memberId: member.id }, async () => ({
      memberId: member.id, lineageRoots: mergeArtifactInputProofs(planRoots,
        await captureArtifactInputProof(actor, params.workspaceId, [
          { kind: "Workspace", id: params.workspaceId }, { kind: "Member", id: member.id, snapshot: member },
          { kind: "User", id: member.user.id, snapshot: member.user },
        ])),
    }), { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers) => {
      const initialReceipt = await helpers.captureInputs(mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]));
      const result = await helpers.step("persist-check-ins", { memberId: context.memberId }, async () =>
        createDailyCompanyUnderstandingQuestions(actor, { workspaceId: params.workspaceId, memberId: context.memberId,
          lineageRoots: context.lineageRoots }), { receipt: initialReceipt, auditedRead: true });
      const roots = mergeArtifactInputProofs(result.lineageRoots, [...helpers.behaviorLineageRoots]);
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Daily question inputs changed before the outcome was saved.");
      const lineageReceipt = await helpers.captureInputs(roots);
      return { lineageReceipt, resultJson: { created: result.created, cap: result.cap } };
    },
  });
}
