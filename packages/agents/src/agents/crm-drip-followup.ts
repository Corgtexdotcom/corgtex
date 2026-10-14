import type { AgentTriggerType, Prisma } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { prisma, sendEmail, type AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, invariant,
  mergeArtifactInputProofs, type LineageRoot, recordDripFollowUp, isArtifactInputProofPubliclyShareable } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

function emailBodyToHtml(body: string) {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    )
    .join("<br />");
}

export function buildCrmDripFollowupSystemPrompt(followUpNumber: number) {
  return [
    "You are a founder reaching out to a demo lead who hasn't responded.",
    `Write a short, warm, personalized email (3-5 sentences). This is follow-up #${followUpNumber}.`,
    "Make it conversational and low pressure.",
    "Frame Corgtex as a practical way to adopt AI while preserving human judgment, operating memory, employee trust, and organizational control.",
    "When useful, describe the Corgtex newspaper as a simple daily operating picture, not as a marketing feature list.",
    "Mention employee-owned, self-managed, or mission-driven fit only when the lead context supports it; do not invent those traits.",
    "Output ONLY the email body.",
  ].join(" ");
}

type DripContext = { email: string; companyHint: string | null; source: string; utmSource: string | null; liveRoots: LineageRoot[]; lineageRoots: LineageRoot[] };

export async function runCrmDripFollowupAgent(params: {
  workspaceId: string; triggerRef: string; triggerType?: AgentTriggerType; lineageActor?: AppActor;
  payload: { demoLeadId: string; followUpNumber: number };
}) {
  const actor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-drip-followup", workspaceIds: [params.workspaceId] };
  const job = await prisma.workflowJob.findFirst({ where: { id: params.triggerRef, workspaceId: params.workspaceId, type: "agent.crm-drip-followup" },
    select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } });
  invariant(job && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload), 409, "UNKNOWN_LINEAGE", "A stored workflow input is required.");
  const stored = job.payload as Record<string, Prisma.JsonValue>;
  const payload = { demoLeadId: String(stored.demoLeadId ?? ""), followUpNumber: Number(stored.followUpNumber ?? 1) };
  invariant(Object.entries(payload).every(([key, value]) => value === params.payload[key as keyof typeof payload]),
    409, "SOURCE_CHANGED", "Dispatch payload differs from its stored workflow input.");
  const jobRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "WorkflowJobInput", id: job.id, snapshot: job }]);
  const planRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, jobRoots, tx));
  return executeAgentRun<typeof payload, DripContext>({
    agentKey: "crm-drip-followup", workspaceId: params.workspaceId, triggerType: params.triggerType ?? "SCHEDULE", triggerRef: job.id,
    lineageActor: actor, lineageRoots: planRoots, contextIsAuditedRead: true, contextLineageRoots: context => context.lineageRoots,
    goal: "Draft and send a personalized follow-up email to a demo lead who hasn't responded.", payload,
    plan: ["load-lead-context", "generate-email", "send-and-record"],
    buildContext: helpers => helpers.step("load-lead-context", {}, async () => {
      const lead = await prisma.demoLead.findFirst({ where: { id: payload.demoLeadId, workspaceId: params.workspaceId } });
      invariant(lead, 404, "NOT_FOUND", "DemoLead not found.");
      invariant(Number.isSafeInteger(payload.followUpNumber) && payload.followUpNumber === lead.followUpCount + 1,
        409, "SOURCE_CHANGED", "This lead's follow-up state changed.");
      const contact = lead.convertedContactId ? await prisma.crmContact.findFirst({ where: { id: lead.convertedContactId, workspaceId: params.workspaceId, archivedAt: null } }) : null;
      if (lead.convertedContactId) invariant(contact, 404, "NOT_FOUND", "Contact not found.");
      const liveRoots = mergeArtifactInputProofs(jobRoots, await captureArtifactInputProof(actor, params.workspaceId,
        [{ kind: "DemoLead", id: lead.id, snapshot: lead }, { kind: "DemoLeadIntakeInput", id: lead.id },
          ...(contact ? [{ kind: "CrmContact" as const, id: contact.id, snapshot: contact }] : []),
          ...(contact?.accountId ? [{ kind: "CrmAccount" as const, id: contact.accountId }] : [])]));
      const lineageRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(actor, params.workspaceId, liveRoots, tx));
      return { email: lead.email, companyHint: lead.companyHint, source: lead.source, utmSource: lead.utmSource, liveRoots, lineageRoots };
    }, { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers, runId, model) => {
      const lineageRoots = mergeArtifactInputProofs(context.liveRoots, [...helpers.behaviorLineageRoots]);
      const revalidate = async () => invariant(await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, lineageRoots),
        403, "SOURCE_RESTRICTED", "Private, unknown, or changed inputs cannot enter external follow-up email.");
      await revalidate();
      const receipt = await helpers.captureInputs(mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]));
      const emailContent = await helpers.tool("model.generate", {}, async () => {
        await revalidate();
        const response = await defaultModelGateway.chat({ model, workspaceId: params.workspaceId, agentRunId: runId, taskType: "AGENT",
          messages: [{ role: "system", content: `${helpers.behaviorContext ?? ""}\n\n${buildCrmDripFollowupSystemPrompt(payload.followUpNumber)}` },
            { role: "user", content: `Lead context: ${JSON.stringify({ email: context.email, companyHint: context.companyHint, source: context.source, utmSource: context.utmSource, followUpNumber: payload.followUpNumber })}` }],
        });
        return response.content;
      }, { receipt });
      const delivery = await helpers.step("send-and-record", {}, async () => {
        await revalidate();
        return recordDripFollowUp(params.workspaceId, payload.demoLeadId, emailContent, { actor, lineageRoots,
          expectedFollowUpNumber: payload.followUpNumber, operationId: job.id,
          send: (recipient, operationId) => sendEmail({ to: recipient, subject: "A quick follow-up from Corgtex", html: emailBodyToHtml(emailContent),
            idempotencyKey: `crm-drip/${operationId}` }),
        });
      }, { receipt });
      return { lineageReceipt: receipt, resultJson: { emailContent, delivery: delivery as Prisma.InputJsonValue } };
    },
  });
}
