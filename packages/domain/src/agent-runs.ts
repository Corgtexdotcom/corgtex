import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { withAgentRunModelUsageSummary } from "./agent-run-usage";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export type AgentKey =
  | "inbox-triage"
  | "meeting-summary"
  | "action-extraction"
  | "proposal-drafting"
  | "constitution-update-trigger"
  | "constitution-synthesis"
  | "finance-reconciliation-prep"
  | "brain-absorb"
  | "brain-maintenance"
  | "advice-routing"
  | "process-linting"
  | "daily-check-in"
  | "spend-submission";

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
    case "finance-reconciliation-prep":
      return "agent.finance-reconciliation-prep";
    case "brain-absorb":
      return "agent.brain-absorb";
    case "brain-maintenance":
      return "agent.brain-maintenance";
    case "advice-routing":
      return "agent.advice-routing";
    case "process-linting":
      return "agent.process-linting";
    case "daily-check-in":
      return "agent.daily-check-in";
    case "spend-submission":
      return "agent.spend-submission";
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
  spendId?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

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
          spendId: params.spendId?.trim() || null,
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
          spendId: params.spendId?.trim() || null,
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

  return prisma.$transaction(async (tx) => {
    // Verify the run belongs to this workspace before touching the step
    const run = await tx.agentRun.findUnique({
      where: { id: params.agentRunId, workspaceId: params.workspaceId },
      select: { id: true },
    });
    invariant(run, 404, "NOT_FOUND", "Agent run not found in this workspace.");

    // Save feedback to the step — scope by agentRunId to prevent cross-run writes
    const step = await tx.agentStep.update({
      where: { id: params.stepId, agentRunId: params.agentRunId },
      data: {
        humanFeedback: params.feedback,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    // Resume the run
    await tx.agentRun.update({
      where: { id: params.agentRunId, workspaceId: params.workspaceId },
      data: {
        status: "PENDING", // Ready for worker to pick up again
      },
    });

    return step;
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
