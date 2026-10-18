import type { AgentTriggerType, Prisma } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { prisma, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, invariant, isArtifactInputProofReadable,
  mergeArtifactInputProofs, type LineageRoot, applyEnrichmentResult } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

type EnrichmentContext = { contactId: string; companyHint: string; liveRoots: LineageRoot[]; lineageRoots: LineageRoot[] };

export async function runCrmLeadEnrichmentAgent(params: {
  workspaceId: string; triggerRef: string; triggerType?: AgentTriggerType; lineageActor?: AppActor;
  payload: { eventId: string; aggregateId: string; email: string };
}) {
  const actor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-lead-enrichment", workspaceIds: [params.workspaceId] };
  const job = await prisma.workflowJob.findFirst({ where: { id: params.triggerRef, workspaceId: params.workspaceId, type: "agent.crm-lead-enrichment" },
    select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } });
  invariant(job && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload), 409, "UNKNOWN_LINEAGE", "A stored workflow input is required.");
  const stored = job.payload as Record<string, Prisma.JsonValue>;
  const payload = { eventId: String(stored.eventId ?? ""), aggregateId: String(stored.aggregateId ?? ""), email: String(stored.email ?? "") };
  invariant(Object.entries(payload).every(([key, value]) => value === params.payload[key as keyof typeof payload]),
    409, "SOURCE_CHANGED", "Dispatch payload differs from its stored workflow input.");
  const jobRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "WorkflowJobInput", id: job.id, snapshot: job }]);
  const planRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, jobRoots, tx));
  return executeAgentRun<typeof payload, EnrichmentContext>({
    agentKey: "crm-lead-enrichment", workspaceId: params.workspaceId, triggerType: params.triggerType ?? "EVENT", triggerRef: job.id,
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true, contextLineageRoots: context => context.lineageRoots,
    goal: "Draft CRM company enrichment using proven contact inputs.", payload,
    plan: ["load-contact", "extract-and-score", "apply-enrichment"],
    buildContext: helpers => helpers.step("load-contact", {}, async () => {
      const contact = await prisma.crmContact.findFirst({ where: { workspaceId: params.workspaceId, email: payload.email, archivedAt: null } });
      invariant(contact, 404, "NOT_FOUND", "CrmContact not found.");
      const liveRoots = mergeArtifactInputProofs(jobRoots, await captureArtifactInputProof(actor, params.workspaceId,
        [{ kind: "CrmContact", id: contact.id, snapshot: contact }, ...(contact.accountId ? [{ kind: "CrmAccount" as const, id: contact.accountId }] : [])]));
      const lineageRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, liveRoots, tx));
      return { contactId: contact.id, companyHint: contact.company || contact.email?.split("@")[1] || "", liveRoots, lineageRoots };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers, runId, model) => {
      const lineageRoots = mergeArtifactInputProofs(context.liveRoots, [...helpers.behaviorLineageRoots]);
      const revalidate = async () => invariant(await isArtifactInputProofReadable(actor, params.workspaceId, lineageRoots),
        409, "SOURCE_CHANGED", "Enrichment inputs changed during generation.");
      await revalidate();
      const receipt = await helpers.captureInputs(mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]));
      // Global search credentials do not establish a workspace provider grant. No query or transient result is admitted.
      const extracted = await helpers.tool("model.extract", { searchUsed: false }, async (operation) => {
        await revalidate();
        return defaultModelGateway.extract(operation.modelRequest({ model, workspaceId: params.workspaceId, agentRunId: runId,
          instruction: `${helpers.behaviorContext ?? ""}\n\nDraft company profile data from parametric knowledge only. No web results were fetched or verified. Use null for uncertain fields and score confidence conservatively (0.0 to 1.0).`,
          input: `Company hint: ${context.companyHint}. Search unavailable: no workspace provider grant.`,
          schemaHint: JSON.stringify({ description: "string | null", industry: "string | null", headquarters: "string | null", confidence: "number" }),
        }));
      }, { receipt });
      await helpers.step("apply-enrichment", {}, async () => {
        await revalidate();
        await applyEnrichmentResult(params.workspaceId, context.contactId, extracted.output as {
          description?: string | null; industry?: string | null; headquarters?: string | null; confidence: number;
        }, { actor, lineageRoots });
      }, { receipt });
      return { lineageReceipt: receipt, resultJson: { extractedData: extracted.output as Prisma.InputJsonValue, searchUsed: false } };
    },
  });
}
