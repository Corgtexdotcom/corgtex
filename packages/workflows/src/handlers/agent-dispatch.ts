import { runInboxTriageAgent, runDailyCheckInAgent, runMeetingSummaryAgent, runActionExtractionAgent, runProposalDraftingAgent, runConstitutionUpdateTriggerAgent, runConstitutionSynthesisAgent, runCrmDripFollowupAgent, runCrmEmailExtractionAgent, runCrmLeadEnrichmentAgent, runCompanyUnderstandingAgent } from "@corgtex/agents";
import { executeAgentRun } from "@corgtex/agents";
import { runBrainMaintenance, absorbSource } from "@corgtex/agents";

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function runAgentWorkflowJob(job: {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: unknown;
}) {
  if (!job.workspaceId) {
    return null;
  }

  const payload = (job.payload ?? {}) as Record<string, unknown>;

  if (job.type === "agent.inbox-triage") {
    return runInboxTriageAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      triggerType: "EVENT",
    });
  }

  if (job.type === "agent.daily-check-in") {
    const memberId = asString(payload.memberId);
    if (!memberId) return null;
    return runDailyCheckInAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      memberId,
      triggerType: "SCHEDULE",
    });
  }

  if (job.type === "agent.meeting-summary") {
    return runMeetingSummaryAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      meetingId: asString(payload.meetingId),
      triggerType: job.type === "agent.meeting-summary" && payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    });
  }

  if (job.type === "agent.action-extraction") {
    return runActionExtractionAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      meetingId: asString(payload.meetingId),
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    });
  }

  if (job.type === "agent.proposal-drafting") {
    return runProposalDraftingAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      prompt: asString(payload.prompt),
      meetingId: asString(payload.meetingId) || null,
      triggerType: payload.triggerType === "API" ? "API" : "MANUAL",
    });
  }

  if (job.type === "agent.constitution-update-trigger") {
    return runConstitutionUpdateTriggerAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      proposalId: asString(payload.proposalId),
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    });
  }

  if (job.type === "agent.constitution-synthesis") {
    return runConstitutionSynthesisAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    });
  }

  if (job.type === "agent.brain-maintenance") {
    return executeAgentRun({
      agentKey: "brain-maintenance",
      workspaceId: job.workspaceId,
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "SCHEDULE",
      triggerRef: job.id,
      goal: "Run weekly brain maintenance: freshness, dead links, orphans, Tier 3 cleanup, backlinks, discussions.",
      payload: {},
      plan: ["freshness-scan", "dead-link-scan", "orphan-detection", "tier3-cleanup", "backlink-rebuild", "discussion-maintenance"],
      buildContext: async (helpers) =>
        helpers.tool("brain.workspace-info", {}, async () => ({ workspaceId: job.workspaceId })),
      execute: async (_context, helpers, runId, _model) =>
        helpers.step("maintenance", {}, async () => {
          const result = await runBrainMaintenance({
            workspaceId: job.workspaceId!,
            agentRunId: runId,
          });
          return { resultJson: result };
        }),
    });
  }

  if (job.type === "agent.brain-absorb") {
    const sourceId = asString(payload.sourceId);
    if (!sourceId) return null;
    return executeAgentRun({
      agentKey: "brain-absorb",
      workspaceId: job.workspaceId,
      triggerType: "EVENT",
      triggerRef: job.id,
      goal: "Absorb a new source into the brain — update or create articles.",
      payload: { sourceId },
      plan: ["load-source", "classify", "match-articles", "absorb", "sync-knowledge", "rebuild-backlinks"],
      buildContext: async (helpers) =>
        helpers.tool("brain.load-source", { sourceId }, async () => ({ sourceId })),
      execute: async (_context, helpers, runId, model) =>
        helpers.step("absorb", { sourceId }, async () => {
          const result = await absorbSource({
            workspaceId: job.workspaceId!,
            sourceId,
            agentRunId: runId,
            model,
          });
          return { resultJson: result };
        }),
    });
  }

  if (job.type === "agent.company-understanding") {
    return runCompanyUnderstandingAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      sourceId: asString(payload.sourceId) || null,
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    });
  }

  if (job.type === "agent.crm-drip-followup") {
    const demoLeadId = asString(payload.demoLeadId);
    if (!demoLeadId) return null;
    return runCrmDripFollowupAgent({
      workspaceId: job.workspaceId!,
      triggerRef: job.id,
      payload: {
        demoLeadId,
        followUpNumber: Number(payload.followUpNumber ?? 1),
      },
    });
  }

  if (job.type === "agent.crm-email-extraction") {
    const qualificationId = asString(payload.qualificationId);
    if (!qualificationId) return null;
    return runCrmEmailExtractionAgent({
      workspaceId: job.workspaceId!,
      triggerRef: job.id,
      payload: {
        eventId: asString(payload.eventId),
        aggregateId: asString(payload.aggregateId),
        qualificationId,
      },
    });
  }

  if (job.type === "agent.crm-lead-enrichment") {
    const email = asString(payload.email);
    if (!email) return null;
    return runCrmLeadEnrichmentAgent({
      workspaceId: job.workspaceId!,
      triggerRef: job.id,
      payload: {
        eventId: asString(payload.eventId),
        aggregateId: asString(payload.aggregateId),
        email,
      },
    });
  }

  return null;
}
