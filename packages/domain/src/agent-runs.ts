import type { AppActor } from "@corgtex/shared";
import { checkRateLimit, prisma, RATE_LIMITS } from "@corgtex/shared";
import { withAgentRunModelUsageSummary } from "./agent-run-usage";
import { requireWorkspaceMembership } from "./auth";
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

export async function listAgentRuns(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
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
      // Historic source-backed runs have no complete content receipt. Their
      // steps and result JSON may include private article names and source text.
      agentKey: { notIn: ["brain-absorb", "brain-source-regenerate", "company-understanding"] },
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
    take: opts?.take ?? 25,
  });

  return runs.map(withAgentRunModelUsageSummary);
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

  return prisma.$transaction(async (tx) => {
    const job = await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: jobTypeForAgent(params.agentKey),
        payload: {
          triggerType: "MANUAL",
          prompt: params.prompt?.trim() || null,
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

  return prisma.agentRun.update({
    where: { id: params.agentRunId, workspaceId: params.workspaceId },
    data: {
      status: params.status,
      completedAt: new Date(),
      failedAt: null,
    },
  });
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

  const feedback = params.feedback.trim();
  invariant(feedback.length > 0 && feedback.length <= 4000, 400, "INVALID_INPUT", "Feedback must be 1 to 4000 characters.");

  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: params.agentRunId, workspaceId: params.workspaceId },
      select: { id: true, agentKey: true, status: true, approvalRequired: true, resultJson: true, planJson: true },
    });
    invariant(run, 404, "NOT_FOUND", "Agent run not found in this workspace.");
    invariant(run.status === "WAITING_APPROVAL" && run.approvalRequired, 409, "INVALID_STATE", "Agent run is not waiting for feedback.");
    const result = run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
      ? run.resultJson as Record<string, unknown> : {};
    const prompt = typeof result.prompt === "string" ? result.prompt.trim().slice(0, 8000) : "";
    const proposalId = typeof result.proposalId === "string" ? result.proposalId.trim().slice(0, 200) : "";
    const plan = run.planJson && typeof run.planJson === "object" && !Array.isArray(run.planJson)
      ? run.planJson as Record<string, unknown> : {};
    const planPayload = plan.payload && typeof plan.payload === "object" && !Array.isArray(plan.payload)
      ? plan.payload as Record<string, unknown> : {};
    const meetingId = typeof planPayload.meetingId === "string" ? planPayload.meetingId.trim().slice(0, 200) : "";
    const previousAdvice = run.agentKey === "proposal-drafting"
      ? JSON.stringify(result.proposalDraft ?? {}).slice(0, 20000)
      : (typeof result.impactSummary === "string" ? result.impactSummary : "").slice(0, 20000);
    invariant(
      (run.agentKey === "proposal-drafting" && Boolean(prompt)) ||
      (run.agentKey === "constitution-update-trigger" && Boolean(proposalId)),
      409, "INVALID_STATE", "This agent run cannot accept a review reply.",
    );
    if (run.agentKey === "constitution-update-trigger") {
      // A stale inbox form cannot revive analysis of a now-hidden or archived proposal.
      await getProposal(actor, { workspaceId: params.workspaceId, proposalId });
    }

    // Conditional claims make simultaneous replies and stale forms mutually exclusive.
    const claimedRun = await tx.agentRun.updateMany({
      where: { id: run.id, workspaceId: params.workspaceId, status: "WAITING_APPROVAL", approvalRequired: true },
      data: {
        status: "COMPLETED", approvalRequired: false, completedAt: new Date(),
        resultJson: { ...result, feedbackDisposition: "ADVISORY_CONTINUATION_QUEUED" },
      },
    });
    invariant(claimedRun.count === 1, 409, "INVALID_STATE", "This review has already been answered.");
    const claimedStep = await tx.agentStep.updateMany({
      where: { id: params.stepId, agentRunId: run.id, name: "approval-checkpoint", status: "PENDING", humanFeedback: null },
      data: { humanFeedback: feedback, status: "COMPLETED", completedAt: new Date() },
    });
    invariant(claimedStep.count === 1, 409, "INVALID_STATE", "This review step has already been answered.");

    const job = await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: run.agentKey === "proposal-drafting" ? "agent.proposal-drafting" : "agent.constitution-update-trigger",
        payload: {
          triggerType: "MANUAL",
          ...(prompt ? { prompt, meetingId: meetingId || null } : { proposalId }),
          reviewFeedback: feedback,
          previousAdvice,
          sourceAgentRunId: run.id,
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
