import { prepareMaintenanceClaim, MaintenanceDeferred } from "../brain-maintenance-jobs";
import { prisma, type AppActor } from "@corgtex/shared";
import { runInboxTriageAgent, runDailyCheckInAgent, runMeetingSummaryAgent, runActionExtractionAgent, runProposalDraftingAgent, runConstitutionUpdateTriggerAgent, runConstitutionSynthesisAgent, runCrmDripFollowupAgent, runCrmEmailExtractionAgent, runCrmLeadEnrichmentAgent, runCompanyUnderstandingAgent } from "@corgtex/agents";
import { executeAgentRun } from "@corgtex/agents";
import { runBrainMaintenance, absorbSource, runBrainSourceRegenerationJob, runBrainArticleVariantJob, runGraphSourceVariantJob } from "@corgtex/agents";
import { assertBrainSourceRecoveryJob, captureArtifactInputProof, withBrainExportWorker, withMeetingTranscriptWorker, getMeetingTranscriptWorkerPurpose, assertMeetingTranscriptWorkerCurrent, invariant } from "@corgtex/domain";

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function runAgentWorkflowJob(job: {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: unknown;
  attempts?: number;
  lockedAt?: Date | null;
}, claimOwner?: string, meetingActor?: AppActor) {
  if (!job.workspaceId) {
    return null;
  }

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const runMeeting = async <T>(work: (actor: AppActor) => Promise<T>) => {
    if (meetingActor) {
      const purpose = getMeetingTranscriptWorkerPurpose(meetingActor, job.workspaceId!);
      invariant(purpose && purpose.jobId === job.id && purpose.jobType === job.type
        && purpose.owner === claimOwner && purpose.attempt === job.attempts
        && purpose.payload === JSON.stringify(job.payload),
      409, "MEETING_WORKFLOW_JOB_LOST", "Meeting dispatch requires the original claimed execution actor.");
      await assertMeetingTranscriptWorkerCurrent(meetingActor, job.workspaceId!);
      return work(meetingActor);
    }
    return withMeetingTranscriptWorker({workspaceId: job.workspaceId!, meetingId: asString(payload.meetingId),
      jobId: job.id, owner: claimOwner ?? "", attempt: job.attempts ?? 0, claim: undefined}, work);
  };

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
    return runMeeting(lineageActor => runMeetingSummaryAgent({
      lineageActor,
      workspaceId: job.workspaceId!,
      triggerRef: job.id,
      meetingId: asString(payload.meetingId),
      triggerType: job.type === "agent.meeting-summary" && payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    }));
  }

  if (job.type === "agent.action-extraction") {
    return runMeeting(lineageActor => runActionExtractionAgent({
      lineageActor,
      workspaceId: job.workspaceId!,
      triggerRef: job.id,
      meetingId: asString(payload.meetingId),
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
    }));
  }

  if (job.type === "agent.proposal-drafting") {
    return runProposalDraftingAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      prompt: asString(payload.prompt),
      meetingId: asString(payload.meetingId) || null,
      triggerType: payload.triggerType === "API" ? "API" : "MANUAL",
      requestInputId: asString(payload.requestInputId) || undefined,
      feedbackInputId: asString(payload.feedbackInputId) || undefined,
      priorRunSnapshotId: asString(payload.priorRunSnapshotId) || undefined,
    });
  }

  if (job.type === "agent.constitution-update-trigger") {
    return runConstitutionUpdateTriggerAgent({
      workspaceId: job.workspaceId,
      triggerRef: job.id,
      proposalId: asString(payload.proposalId),
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "EVENT",
      requestInputId: asString(payload.requestInputId) || undefined,
      feedbackInputId: asString(payload.feedbackInputId) || undefined,
      priorRunSnapshotId: asString(payload.priorRunSnapshotId) || undefined,
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
    const claim = await prepareMaintenanceClaim(job, claimOwner ?? "");
    if (await claim.recoverOrVerifyExisting()) return {status: "COMPLETED"};
    const lineageActor: AppActor = {kind: "agent", authProvider: "bootstrap", label: "brain-maintenance", workspaceIds: [job.workspaceId]};
    const lineageRoots = await captureArtifactInputProof(lineageActor, job.workspaceId, [{kind: "Workspace", id: job.workspaceId}]);
    let prepared: Awaited<ReturnType<typeof runBrainMaintenance>> | undefined;
    const result = await executeAgentRun({
      lineageActor, lineageRoots,
      contextLineageRoots: () => lineageRoots,
      agentKey: "brain-maintenance", workspaceId: job.workspaceId,
      triggerType: payload.triggerType === "MANUAL" ? "MANUAL" : "SCHEDULE", triggerRef: job.id,
      goal: "Observe and maintain one admitted Brain batch.", payload: {scope: "BATCH", phase: claim.state.phase},
      plan: ["observe-current-batch", "apply-proved-batch", "handoff"],
      buildContext: async helpers => helpers.tool("brain.maintenance-batch", {scope: "BATCH", phase: claim.state.phase},
        async () => ({scope: "BATCH", phase: claim.state.phase}), {receipt: helpers.plannedInputReceipt}),
      execute: async (_context, helpers) => {
        prepared = await runBrainMaintenance({workspaceId: job.workspaceId!, actor: lineageActor, state: claim.state});
        await prepared.assertCurrent();
        const receipt = prepared.lineageRoots.length ? await helpers.captureInputs(prepared.lineageRoots) : helpers.plannedInputReceipt;
        const report = prepared.lineageRoots.length || claim.state.phase === "RETENTION" ? prepared.report : {scope: "BATCH", phase: claim.state.phase,
          observation: "Operational phase completion only; no source-derived counts", status: "OPERATION_COMPLETED"};
        // The step is an operational phase marker. Publish the source-derived
        // report once on AgentRun, under its original captured input receipt.
        await helpers.step("maintenance-batch", {scope: "BATCH", phase: claim.state.phase},
          async () => ({scope: "BATCH", phase: claim.state.phase}), {receipt: helpers.plannedInputReceipt});
        return {resultJson: report, lineageReceipt: receipt};
      },
      beforeComplete: async tx => {
        await claim.assertCurrent(tx);
        invariant(prepared, 409, "MAINTENANCE_STATE_INVALID", "Maintenance observation is missing.");
        await prepared.apply(tx);
        await claim.finish(tx, prepared.next);
      },
    });
    if ("skipped" in result && result.skipped) {
      if (["agent_disabled", "kill_switch", "budget_exceeded", "agent_identity_inactive", "daily_rate_limit", "hourly_rate_limit", "concurrency_limit"].includes(result.reason)) {
        throw new MaintenanceDeferred(result.reason);
      }
      throw new Error("Maintenance did not reach a source-proven batch checkpoint.");
    }
    invariant("status" in result && result.status === "COMPLETED", 409, "MAINTENANCE_STATE_INVALID", "Maintenance batch did not complete.");
    claim.acknowledgeCommit();
    return result;
  }

  if (job.type === "agent.brain-absorb") {
    const sourceId = asString(payload.sourceId);
    if (!sourceId) return null;
    const expectedSourceIdentity = payload.supportRecovery === true ? asString(payload.expectedSourceIdentity) : undefined;
    if (payload.supportRecovery === true && !/^[a-f0-9]{64}$/.test(expectedSourceIdentity ?? "")) {
      throw new Error("Invalid source recovery identity.");
    }
    if (expectedSourceIdentity) {
      const admission = await assertBrainSourceRecoveryJob({ workspaceId: job.workspaceId, sourceId, workflowJobId: job.id, expectedSourceIdentity });
      if (admission?.alreadyCompleted) return admission;
    }
    const workspaceId = job.workspaceId;
    const executeAbsorption = async (lineageActor?: AppActor) => {
      const lineageRoots = lineageActor ? await captureArtifactInputProof(lineageActor, workspaceId, [{kind: "BrainSource", id: sourceId}]) : undefined;
      return executeAgentRun({
        ...(lineageActor && lineageRoots ? {lineageActor, lineageRoots, contextLineageRoots: () => lineageRoots} : {}),
        agentKey: "brain-absorb", workspaceId, triggerType: "EVENT", triggerRef: job.id,
        goal: "Absorb a new source into the brain — update or create articles.", payload: {sourceId},
        plan: ["load-source", "classify", "match-articles", "absorb", "sync-knowledge", "rebuild-backlinks"],
        buildContext: async helpers => helpers.tool("brain.load-source", {sourceId}, async () => ({sourceId}),
          {receipt: helpers.plannedInputReceipt}),
        execute: async (_context, helpers, runId, model) => helpers.step("absorb", {sourceId}, async () => {
          const result = await absorbSource({workspaceId, sourceId, agentRunId: runId, model,
            ...(lineageActor ? {actor: lineageActor} : {}), ...(expectedSourceIdentity ? {expectedSourceIdentity} : {})});
          if (payload.supportRecovery === true && "skipped" in result && result.skipped === true) {
            throw new Error("Brain source recovery did not complete absorption.");
          }
          const lineageReceipt = lineageActor && "lineageRoots" in result && result.lineageRoots?.length
            ? await helpers.captureInputs(result.lineageRoots) : undefined;
          return {resultJson: result, ...(lineageReceipt ? {lineageReceipt} : {})};
        }, {receipt: helpers.plannedInputReceipt}),
      });
    };
    const source = await prisma.brainSource.findFirst({where: {id: sourceId, workspaceId}, select: {channel: true}});
    const result = source?.channel === "chat-consent"
      ? await withBrainExportWorker({workspaceId, sourceId, jobId: job.id, owner: claimOwner ?? "", attempt: job.attempts ?? 0}, executeAbsorption)
      : await executeAbsorption();
    if (payload.supportRecovery === true && result && "skipped" in result && result.skipped === true) {
      throw new Error("Brain source recovery was skipped by agent runtime before processing.");
    }
    return result;
  }

  if (job.type === "agent.graph-source-variant") {
    if (!Number.isSafeInteger(job.attempts) || (job.attempts ?? 0) < 1 || !claimOwner) {
      throw new Error("Graph variant generation requires a claimed worker attempt.");
    }
    return runGraphSourceVariantJob({workspaceId: job.workspaceId, jobId: job.id, expectedAttempt: job.attempts!, expectedOwner: claimOwner});
  }

  if (job.type === "agent.brain-article-variant") {
    if (!Number.isSafeInteger(job.attempts) || (job.attempts ?? 0) < 1 || !claimOwner) {
      throw new Error("Article variant generation requires a claimed worker attempt.");
    }
    return runBrainArticleVariantJob({ workspaceId: job.workspaceId, jobId: job.id, expectedAttempt: job.attempts!, expectedOwner: claimOwner });
  }

  if (job.type === "agent.brain-source-regenerate") {
    if (!Number.isSafeInteger(job.attempts) || (job.attempts ?? 0) < 1 || !claimOwner) {
      throw new Error("Brain source regeneration requires a claimed worker attempt.");
    }
    return runBrainSourceRegenerationJob({ workspaceId: job.workspaceId, jobId: job.id, expectedAttempt: job.attempts!, expectedOwner: claimOwner });
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
