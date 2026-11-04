import type { AgentTriggerType, Prisma } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, invariant, isArtifactInputProofReadable,
  mergeArtifactInputProofs, type LineageRoot, applyExtractionResult } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

type EmailContext = { rawEmailReply: string; liveRoots: LineageRoot[]; lineageRoots: LineageRoot[] };

export async function runCrmEmailExtractionAgent(params: {
  workspaceId: string; triggerRef: string; triggerType?: AgentTriggerType; lineageActor?: AppActor;
  payload: { eventId: string; aggregateId: string; qualificationId: string };
}) {
  const actor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-email-extraction", workspaceIds: [params.workspaceId] };
  const job = await prisma.workflowJob.findFirst({ where: { id: params.triggerRef, workspaceId: params.workspaceId, type: "agent.crm-email-extraction" },
    select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } });
  invariant(job && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload), 409, "UNKNOWN_LINEAGE", "A stored workflow input is required.");
  const stored = job.payload as Record<string, Prisma.JsonValue>;
  const payload = { eventId: String(stored.eventId ?? ""), aggregateId: String(stored.aggregateId ?? ""), qualificationId: String(stored.qualificationId ?? "") };
  invariant(Object.entries(payload).every(([key, value]) => value === params.payload[key as keyof typeof payload]),
    409, "SOURCE_CHANGED", "Dispatch payload differs from its stored workflow input.");
  const jobRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "WorkflowJobInput", id: job.id, snapshot: job }]);
  const planRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, jobRoots, tx));
  return executeAgentRun<typeof payload, EmailContext>({
    agentKey: "crm-email-extraction", workspaceId: params.workspaceId, triggerType: params.triggerType ?? "EVENT", triggerRef: job.id,
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true, contextLineageRoots: context => context.lineageRoots,
    goal: "Extract structured qualification fields from the raw email reply.", payload,
    plan: ["load-context", "extract-fields", "update-qualification"],
    buildContext: helpers => helpers.step("load-context", {}, async () => {
      const qualification = await prisma.crmQualification.findFirst({ where: { id: payload.qualificationId, workspaceId: params.workspaceId, responseChannel: "email_reply" },
        select: { id: true, workspaceId: true, demoLeadId: true, responseChannel: true, rawEmailReply: true, rawEmailSubject: true, createdAt: true } });
      invariant(qualification?.rawEmailReply, 404, "NOT_FOUND", "Qualification not found or missing rawEmailReply.");
      const liveRoots = mergeArtifactInputProofs(jobRoots, await captureArtifactInputProof(actor, params.workspaceId,
        [{ kind: "CrmQualificationEmailInput", id: qualification.id, snapshot: qualification }]));
      const lineageRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, liveRoots, tx));
      return { rawEmailReply: qualification.rawEmailReply, liveRoots, lineageRoots };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers, runId, model) => {
      const lineageRoots = mergeArtifactInputProofs(context.liveRoots, [...helpers.behaviorLineageRoots]);
      const revalidate = async () => invariant(await isArtifactInputProofReadable(actor, params.workspaceId, lineageRoots),
        409, "SOURCE_CHANGED", "Qualification inputs changed during extraction.");
      await revalidate();
      const receipt = await helpers.captureInputs(mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]));
      const extracted = await helpers.tool("model.extract", {}, async (operation) => {
        await revalidate();
        return defaultModelGateway.extract(operation.modelRequest({ model, workspaceId: params.workspaceId, agentRunId: runId,
          instruction: `${helpers.behaviorContext ?? ""}\n\nExtract companyName, website, aiExperience, and helpNeeded from the following raw email reply.`,
          input: context.rawEmailReply,
          schemaHint: JSON.stringify({ companyName: "string | null", website: "string | null", aiExperience: "string | null", helpNeeded: "string | null" }),
        }));
      }, { receipt });
      await helpers.step("update-qualification", {}, async () => {
        await revalidate();
        await applyExtractionResult(params.workspaceId, payload.qualificationId, extracted.output, { actor, lineageRoots });
      }, { receipt });
      return { lineageReceipt: receipt, resultJson: extracted.output as Prisma.InputJsonValue };
    },
  });
}
