import type { AgentRun, AgentStep, AgentToolCall, Prisma } from "@prisma/client";
import { readableArtifactIds, captureArtifactInputProof, captureArtifactInputSnapshotProof, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import type { AppActor } from "@corgtex/shared";
import { checkRateLimit, prisma, RATE_LIMITS } from "@corgtex/shared";
import { withAgentRunModelUsageSummary } from "./agent-run-usage";
import { requireWorkspaceMembership } from "./auth";
import { mergeArtifactInputProofs } from "./digest-lineage";
import { invariant } from "./errors";
import { getProposal } from "./proposals";

export type AgentKey =
  | "inbox-triage"
  | "meeting-summary"
  | "action-extraction"
  | "proposal-drafting"
  | "constitution-update-trigger"
  | "constitution-synthesis"
  | "brain-absorb"
  | "company-understanding"
  | "brain-maintenance"
  | "daily-check-in"
  | "slack-agent"
  | "crm-email-extraction"
  | "crm-drip-followup"
  | "crm-lead-enrichment";

function jobTypeForAgent(agentKey: AgentKey) {
  switch (agentKey) {
    case "inbox-triage":
      return "agent.inbox-triage";
    case "meeting-summary":
      return "agent.meeting-summary";
    case "action-extraction":
      return "agent.action-extraction";
    case "proposal-drafting":
      return "agent.proposal-drafting";
    case "constitution-update-trigger":
      return "agent.constitution-update-trigger";
    case "constitution-synthesis":
      return "agent.constitution-synthesis";
    case "brain-absorb":
      return "agent.brain-absorb";
    case "company-understanding":
      return "agent.company-understanding";
    case "brain-maintenance":
      return "agent.brain-maintenance";
    case "daily-check-in":
      return "agent.daily-check-in";
    case "slack-agent":
      return "communication.slack.agent";
    case "crm-email-extraction":
      return "agent.crm-email-extraction";
    case "crm-drip-followup":
      return "agent.crm-drip-followup";
    case "crm-lead-enrichment":
      return "agent.crm-lead-enrichment";
  }
}

/** Operational metadata remains available; copied content requires its own complete receipt. */
export async function redactAgentRunContent<TUsage>(actor: AppActor, workspaceId: string,
  run: AgentRun & { steps: AgentStep[]; toolCalls: AgentToolCall[]; modelUsage: TUsage[] },
  db: Prisma.TransactionClient = prisma) {
  await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  invariant(run.workspaceId === workspaceId, 404, "NOT_FOUND", "Agent run not found in this workspace.");
  const steps = run.steps.filter(step => step.agentRunId === run.id);
  const toolCalls = run.toolCalls.filter(call => call.agentRunId === run.id);
  const [runsReadable, stepsReadable, toolsReadable] = await Promise.all([
    readableArtifactIds(actor, workspaceId, "AgentRun", [run], db),
    steps.length ? readableArtifactIds(actor, workspaceId, "AgentStep", steps, db) : new Set<string>(),
    toolCalls.length ? readableArtifactIds(actor, workspaceId, "AgentToolCall", toolCalls, db) : new Set<string>(),
  ]);
  const readable = runsReadable.has(run.id);
  // Cost and model breakdowns have a separate current financial permission boundary.
  const usageIds = run.modelUsage.map(row => (row as { id?: string }).id).filter((id): id is string => Boolean(id));
  const costRows = readable && usageIds.length ? await db.modelUsage.findMany({ where: { workspaceId, id: { in: usageIds } },
    select: { id: true, workspaceId: true, estimatedCostUsd: true, billableCostUsd: true, createdAt: true } }) : [];
  const costReadable = costRows.length ? await readableArtifactIds(actor, workspaceId, "ModelUsageCost", costRows, db) : new Set<string>();
  const usageReadable = readable && usageIds.length === run.modelUsage.length && costRows.length === usageIds.length
    && costRows.every(row => costReadable.has(row.id));
  return {
    id: run.id, workspaceId: run.workspaceId, agentKey: run.agentKey, triggerType: run.triggerType,
    status: run.status, approvalRequired: run.approvalRequired, startedAt: run.startedAt,
    completedAt: run.completedAt, failedAt: run.failedAt, createdAt: run.createdAt, updatedAt: run.updatedAt,
    contentReadable: readable,
    goal: readable ? run.goal : "Content unavailable",
    triggerRef: readable ? run.triggerRef : null,
    planJson: readable ? run.planJson : null, contextJson: readable ? run.contextJson : null,
    resultJson: readable ? run.resultJson : null,
    steps: steps.map(step => {
      const visible = stepsReadable.has(step.id);
      return { id: step.id, agentRunId: step.agentRunId, status: step.status, startedAt: step.startedAt,
        completedAt: step.completedAt, createdAt: step.createdAt, contentReadable: visible,
        name: visible ? step.name : "Content unavailable", inputJson: visible ? step.inputJson : null,
        outputJson: visible ? step.outputJson : null, error: visible ? step.error : null,
        humanFeedback: visible ? step.humanFeedback : null };
    }),
    toolCalls: toolCalls.map(call => {
      const visible = toolsReadable.has(call.id);
      return { id: call.id, agentRunId: call.agentRunId, status: call.status, startedAt: call.startedAt,
        completedAt: call.completedAt, createdAt: call.createdAt, contentReadable: visible,
        name: visible ? call.name : "Content unavailable", inputJson: visible ? call.inputJson : null,
        outputJson: visible ? call.outputJson : null, error: visible ? call.error : null };
    }),
    modelUsage: usageReadable ? run.modelUsage : [],
  };
}

export async function listAgentRuns(actor: AppActor, workspaceId: string, opts?: {
  take?: number | null;
  agentKey?: string;
  status?: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
  });

  const runs = await prisma.agentRun.findMany({
    where: {
      workspaceId,
      status: opts?.status,
      ...(opts?.agentKey ? { agentKey: opts.agentKey } : {}),
    },
    include: {
      steps: {
        orderBy: { createdAt: "asc" },
      },
      toolCalls: {
        orderBy: { createdAt: "asc" },
      },
      modelUsage: {
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          latencyMs: true,
          estimatedCostUsd: true,
          billableCostUsd: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take === null ? undefined : opts?.take ?? 25,
  });

  return Promise.all(runs.map(async (run) => withAgentRunModelUsageSummary(await redactAgentRunContent(actor, workspaceId, run))));
}

export async function triggerAgentRun(actor: AppActor, params: {
  workspaceId: string;
  agentKey: AgentKey;
  prompt?: string | null;
  meetingId?: string | null;
  proposalId?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  const rateLimit = await checkRateLimit(`ws:${params.workspaceId}:agent-runs`, RATE_LIMITS.AGENT_PER_WORKSPACE);
  invariant(rateLimit.allowed, 429, "RATE_LIMITED", "Agent run rate limit exceeded.");

  if (params.agentKey === "proposal-drafting") {
    invariant(Boolean(params.prompt?.trim()), 400, "INVALID_INPUT", "Proposal drafting requires a prompt.");
  }

  if (params.agentKey === "meeting-summary" || params.agentKey === "action-extraction") {
    invariant(Boolean(params.meetingId?.trim()), 400, "INVALID_INPUT", `${params.agentKey} requires a meeting ID.`);
  }

  if (params.agentKey === "constitution-update-trigger") {
    invariant(Boolean(params.proposalId?.trim()), 400, "INVALID_INPUT", "Constitution update trigger requires a proposal ID.");
  }

  invariant(actor.kind === "user", 403, "FORBIDDEN", "Manual agent requests require an authenticated author.");
  return prisma.$transaction(async (tx) => {
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"], tx });
    const request = await tx.agentRequestInput.create({ data: {
      workspaceId: params.workspaceId, userId: actor.user.id, agentKey: params.agentKey,
      prompt: params.prompt?.trim() || "", meetingId: params.meetingId?.trim() || null, proposalId: params.proposalId?.trim() || null,
    } });
    const job = await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: jobTypeForAgent(params.agentKey),
        payload: {
          triggerType: "MANUAL",
          requestInputId: request.id,
          meetingId: params.meetingId?.trim() || null,
          proposalId: params.proposalId?.trim() || null,
        },
      },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "agentRun.triggered",
        entityType: "WorkflowJob",
        entityId: job.id,
        meta: {
          agentKey: params.agentKey,
          prompt: params.prompt?.trim() || null,
          meetingId: params.meetingId?.trim() || null,
          proposalId: params.proposalId?.trim() || null,
        },
      },
    });

    return job;
  });
}

export async function resolveAgentRun(actor: AppActor, params: {
  workspaceId: string;
  agentRunId: string;
  status: "COMPLETED" | "CANCELLED";
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  const run = await prisma.agentRun.update({
    where: { id: params.agentRunId, workspaceId: params.workspaceId },
    data: {
      status: params.status,
      completedAt: new Date(),
      failedAt: null,
    },
  });
  return redactAgentRunContent(actor, params.workspaceId, { ...run, steps: [], toolCalls: [], modelUsage: [] });
}

export async function submitAgentFeedback(actor: AppActor, params: {
  workspaceId: string;
  agentRunId: string;
  stepId: string;
  feedback: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  invariant(actor.kind === "user", 403, "FORBIDDEN", "Agent feedback requires an authenticated author.");
  const feedback = params.feedback.trim();
  invariant(feedback.length > 0 && feedback.length <= 4000, 400, "INVALID_INPUT", "Feedback must be 1 to 4000 characters.");

  return prisma.$transaction(async (tx) => {
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"], tx });
    await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE id = ${params.agentRunId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AgentStep" WHERE id = ${params.stepId} AND "agentRunId" = ${params.agentRunId} FOR UPDATE`;
    const run = await tx.agentRun.findUnique({
      where: { id: params.agentRunId, workspaceId: params.workspaceId },
    });
    invariant(run, 404, "NOT_FOUND", "Agent run not found in this workspace.");
    invariant(run.status === "WAITING_APPROVAL" && run.approvalRequired, 409, "INVALID_STATE", "Agent run is not waiting for feedback.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "AgentRun", [run], tx)).has(run.id),
      409, "UNKNOWN_LINEAGE", "Agent run inputs are no longer available for continuation.");
    const result = run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
      ? run.resultJson as Record<string, unknown> : {};
    const prompt = typeof result.prompt === "string" ? result.prompt.trim().slice(0, 8000) : "";
    const proposalId = typeof result.proposalId === "string" ? result.proposalId.trim().slice(0, 200) : "";

    invariant(
      (run.agentKey === "proposal-drafting" && Boolean(prompt)) ||
      (run.agentKey === "constitution-update-trigger" && Boolean(proposalId)),
      409, "INVALID_STATE", "This agent run cannot accept a review reply.",
    );
    if (run.agentKey === "constitution-update-trigger") {
      // A stale inbox form cannot revive analysis of a now-hidden or archived proposal.
      await getProposal(actor, { workspaceId: params.workspaceId, proposalId });
    }

    const step = await tx.agentStep.findFirst({ where: { id: params.stepId, agentRunId: run.id, name: "approval-checkpoint", status: "PENDING", humanFeedback: null } });
    invariant(step, 409, "INVALID_STATE", "This review step has already been answered.");
    const priorRoots = await captureArtifactInputSnapshotProof(actor, params.workspaceId, { kind: "AgentRun", id: run.id, fingerprint: lineageContentFingerprint("AgentRun", run) }, tx);
    const priorRunSnapshotId = priorRoots.find(root => root.kind === "ArtifactInputSnapshot")!.id;
    const input = await tx.agentFeedbackInput.create({ data: {
      workspaceId: params.workspaceId, agentRunId: run.id, stepId: step.id, userId: actor.user.id, content: feedback, priorRunSnapshotId,
    } });
    const feedbackRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "AgentFeedbackInput", id: input.id, snapshot: input }], tx);
    const stepRoots = await captureArtifactInputSnapshotProof(actor, params.workspaceId, { kind: "AgentStep", id: step.id, fingerprint: lineageContentFingerprint("AgentStep", step) }, tx);
    // Conditional claims make simultaneous replies and stale forms mutually exclusive.
    const claimedRun = await tx.agentRun.updateMany({
      where: { id: run.id, workspaceId: params.workspaceId, status: "WAITING_APPROVAL", approvalRequired: true },
      data: {
        status: "COMPLETED", approvalRequired: false, completedAt: new Date(),

      },
    });
    invariant(claimedRun.count === 1, 409, "INVALID_STATE", "This review has already been answered.");
    const claimedStep = await tx.agentStep.updateMany({
      where: { id: params.stepId, agentRunId: run.id, name: "approval-checkpoint", status: "PENDING", humanFeedback: null },
      data: { humanFeedback: feedback, status: "COMPLETED", completedAt: new Date() },
    });
    invariant(claimedStep.count === 1, 409, "INVALID_STATE", "This review step has already been answered.");

    const updatedStep = await tx.agentStep.findUniqueOrThrow({ where: { id: step.id } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "AgentStep", id: step.id },
      content: updatedStep, origin: "DERIVED", inputs: [], inheritedRoots: mergeArtifactInputProofs(stepRoots, feedbackRoots) });
    const job = await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: run.agentKey === "proposal-drafting" ? "agent.proposal-drafting" : "agent.constitution-update-trigger",
        payload: {
          triggerType: "MANUAL",
          feedbackInputId: input.id,
          priorRunSnapshotId,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "agentRun.feedbackSubmitted",
        entityType: "AgentRun",
        entityId: run.id,
        meta: { continuationJobId: job.id, stepId: params.stepId },
      },
    });
    return { id: params.stepId, continuationJobId: job.id };
  });
}

export async function getFailingAgents(workspaceId: string): Promise<string[]> {
  const recentRuns = await prisma.agentRun.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { agentKey: true, status: true },
  });

  const failuresByKey: Record<string, number> = {};
  for (const run of recentRuns) {
    if (run.status === "FAILED") {
      failuresByKey[run.agentKey] = (failuresByKey[run.agentKey] || 0) + 1;
    } else if (run.status === "COMPLETED") {
      // Reset if we see a success before we hit 3 failures
      if (!failuresByKey[run.agentKey] || failuresByKey[run.agentKey] < 3) {
        failuresByKey[run.agentKey] = -100; // prevent this agent from being marked as failing
      }
    }
  }

  const failingAgents = [];
  for (const [agentKey, failureCount] of Object.entries(failuresByKey)) {
    if (failureCount >= 3) {
      failingAgents.push(agentKey);
    }
  }
  return failingAgents;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function inputAuthor(db: Prisma.TransactionClient, workspaceId: string, userId: string): Promise<AppActor> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, globalRole: true } });
  invariant(user, 403, "FORBIDDEN", "Agent input author is unavailable.");
  const actor: AppActor = { kind: "user", user };
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"], tx: db });
  return actor;
}

/** Jobs carry identities only. Always reread the immutable, authored request. */
export async function loadAgentRequestInput(params: { workspaceId: string; requestInputId: string; agentKey: string }) {
  return prisma.$transaction(async tx => {
    const input = await tx.agentRequestInput.findFirst({ where: { id: params.requestInputId, workspaceId: params.workspaceId, agentKey: params.agentKey } });
    invariant(input, 409, "UNKNOWN_LINEAGE", "The authored agent request is unavailable.");
    const actor = await inputAuthor(tx, params.workspaceId, input.userId);
    const lineageRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "AgentRequestInput", id: input.id, snapshot: input }], tx);
    return { actor, prompt: input.prompt, meetingId: input.meetingId, proposalId: input.proposalId, lineageRoots };
  });
}

/** A feedback continuation uses the exact prior approved-for-reading snapshot plus the new human input. */
export async function loadAgentFeedbackContinuation(params: { workspaceId: string; feedbackInputId: string; priorRunSnapshotId: string; agentKey: string }) {
  return prisma.$transaction(async tx => {
    const input = await tx.agentFeedbackInput.findFirst({ where: { id: params.feedbackInputId, workspaceId: params.workspaceId } });
    const snapshot = await tx.artifactInputSnapshot.findFirst({ where: { id: params.priorRunSnapshotId, workspaceId: params.workspaceId, sourceKind: "AgentRun" } });
    invariant(input && snapshot && input.priorRunSnapshotId === snapshot.id && snapshot.sourceId === input.agentRunId, 409, "UNKNOWN_LINEAGE", "The feedback continuation receipt is unavailable.");
    const run = await tx.agentRun.findFirst({ where: { id: input.agentRunId, workspaceId: params.workspaceId, agentKey: params.agentKey } });
    invariant(run, 409, "UNKNOWN_LINEAGE", "The feedback run is unavailable.");
    const actor = await inputAuthor(tx, params.workspaceId, input.userId);
    const lineageRoots = await captureArtifactInputProof(actor, params.workspaceId, [
      { kind: "AgentFeedbackInput", id: input.id, snapshot: input }, { kind: "ArtifactInputSnapshot", id: snapshot.id, snapshot },
    ], tx);
    const prior = jsonRecord(snapshot.contentJson);
    const result = jsonRecord(prior.resultJson);
    const payload = jsonRecord(jsonRecord(prior.planJson).payload);
    return { actor, lineageRoots, prompt: typeof result.prompt === "string" ? result.prompt : "",
      meetingId: typeof payload.meetingId === "string" ? payload.meetingId : null,
      proposalId: typeof result.proposalId === "string" ? result.proposalId : null,
      reviewFeedback: input.content,
      previousAdvice: params.agentKey === "proposal-drafting" ? JSON.stringify(result.proposalDraft ?? {})
        : typeof result.impactSummary === "string" ? result.impactSummary : "" };
  });
}
