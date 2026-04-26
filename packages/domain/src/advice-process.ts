import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

// Determine default deadline (e.g. 7 days from now)
function getDefaultDeadline() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

export async function initiateAdviceProcess(
  actor: AppActor,
  params: { workspaceId: string; proposalId: string; adviceDeadlineDays?: number }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can initiate an advice process");

  const proposal = await prisma.proposal.findUnique({
    where: { id: params.proposalId, workspaceId: params.workspaceId },
  });

  invariant(proposal, 404, "NOT_FOUND", "Proposal not found");
  invariant(proposal.authorUserId === actor.user.id, 403, "FORBIDDEN", "Only the author can initiate the advice process");
  invariant(proposal.status === "DRAFT", 400, "INVALID_STATE", "Proposal must be in DRAFT status to begin advice process");

  let deadline = getDefaultDeadline();
  if (params.adviceDeadlineDays) {
    deadline = new Date();
    deadline.setDate(deadline.getDate() + params.adviceDeadlineDays);
  }

  return prisma.$transaction(async (tx) => {
    // We need the member ID for the author
    const authorMember = await tx.member.findUnique({
      where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: actor.user.id } },
    });
    invariant(authorMember, 404, "NOT_FOUND", "Author member record not found");

    const process = await tx.adviceProcess.create({
      data: {
        workspaceId: params.workspaceId,
        proposalId: params.proposalId,
        authorMemberId: authorMember.id,
        status: "GATHERING",
        adviceDeadline: deadline,
      },
    });

    await tx.proposal.update({
      where: { id: params.proposalId },
      data: { status: "OPEN" },
    });

    await tx.event.create({
      data: {
        workspaceId: params.workspaceId,
        type: "advice-process.initiated",
        aggregateType: "AdviceProcess",
        aggregateId: process.id,
        payload: { proposalId: params.proposalId, deadline: deadline.toISOString() },
      },
    });

    return process;
  });
}

export async function recordAdvice(
  actor: AppActor,
  params: { workspaceId: string; processId: string; type: "ENDORSE" | "CONCERN"; bodyMd: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can record advice");

  const process = await prisma.adviceProcess.findUnique({
    where: { id: params.processId, workspaceId: params.workspaceId },
  });

  invariant(process, 404, "NOT_FOUND", "Advice process not found");
  invariant(process.status === "GATHERING" || process.status === "READY", 400, "INVALID_STATE", "Cannot record advice at this stage");
  invariant(params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Advice body cannot be empty");

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: actor.user.id } },
    });
    invariant(member, 404, "NOT_FOUND", "Member record not found");

    const advice = await tx.adviceRecord.create({
      data: {
        processId: params.processId,
        memberId: member.id,
        type: params.type,
        bodyMd: params.bodyMd.trim(),
      },
    });

    await tx.event.create({
      data: {
        workspaceId: params.workspaceId,
        type: "advice-process.advice-recorded",
        aggregateType: "AdviceRecord",
        aggregateId: advice.id,
        payload: { processId: params.processId, type: params.type },
      },
    });

    return advice;
  });
}

export async function withdrawAdviceProcess(actor: AppActor, params: { workspaceId: string; processId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can withdraw advice process");

  const process = await prisma.adviceProcess.findUnique({
    where: { id: params.processId, workspaceId: params.workspaceId },
    include: { authorMember: true },
  });

  invariant(process, 404, "NOT_FOUND", "Advice process not found");
  invariant(process.authorMember.userId === actor.user.id, 403, "FORBIDDEN", "Only the author can withdraw");
  invariant(process.status === "GATHERING" || process.status === "READY", 400, "INVALID_STATE", "Cannot withdraw at this stage");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.adviceProcess.update({
      where: { id: params.processId },
      data: {
        status: "WITHDRAWN",
        withdrawnAt: new Date(),
      },
    });

    await tx.proposal.update({
      where: { id: process.proposalId },
      data: { status: "DRAFT" },
    });

    await tx.event.create({
      data: {
        workspaceId: params.workspaceId,
        type: "advice-process.withdrawn",
        aggregateType: "AdviceProcess",
        aggregateId: process.id,
        payload: { proposalId: process.proposalId },
      },
    });

    return updated;
  });
}

export async function executeAdviceProcessDecision(
  actor: AppActor,
  params: { workspaceId: string; processId: string; decisionMd?: string }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can execute advice process decision");

  const process = await prisma.adviceProcess.findUnique({
    where: { id: params.processId, workspaceId: params.workspaceId },
    include: { authorMember: true, proposal: true },
  });

  invariant(process, 404, "NOT_FOUND", "Advice process not found");
  invariant(process.authorMember.userId === actor.user.id, 403, "FORBIDDEN", "Only the author can execute the decision");
  invariant(process.status === "GATHERING" || process.status === "READY", 400, "INVALID_STATE", "Cannot execute at this stage");

  return prisma.$transaction(async (tx) => {
    const executed = await tx.adviceProcess.update({
      where: { id: params.processId },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
      },
    });

    await tx.proposal.update({
      where: { id: process.proposalId },
      data: {
        status: "RESOLVED",
        resolutionOutcome: "ADOPTED",
        decisionMd: params.decisionMd?.trim() || null,
        decidedAt: new Date(),
      },
    });

    // Create policy corpus entry if it's an executed proposal
    const policy = await tx.policyCorpus.findUnique({ where: { proposalId: process.proposalId } });
    if (!policy) {
      await tx.policyCorpus.create({
        data: {
          workspaceId: process.workspaceId,
          circleId: process.proposal.circleId,
          title: process.proposal.title,
          bodyMd: params.decisionMd ? `${process.proposal.bodyMd}\n\n**Decision Rationale:**\n${params.decisionMd}` : process.proposal.bodyMd,
          proposalId: process.proposalId,
          acceptedAt: new Date(),
        },
      });
    }

    await tx.event.create({
      data: {
        workspaceId: params.workspaceId,
        type: "advice-process.executed",
        aggregateType: "AdviceProcess",
        aggregateId: process.id,
        payload: { proposalId: process.proposalId },
      },
    });

    return executed;
  });
}

export async function getAdviceProcessSummary(actor: AppActor, workspaceId: string, processId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const process = await prisma.adviceProcess.findUnique({
    where: { id: processId, workspaceId },
    include: {
      records: {
        include: {
          member: { include: { user: { select: { displayName: true } } } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  invariant(process, 404, "NOT_FOUND", "Advice process not found");

  const endorsements = process.records.filter((r) => r.type === "ENDORSE");
  const concerns = process.records.filter((r) => r.type === "CONCERN");

  return {
    process,
    endorsements,
    concerns,
    records: process.records,
    advisorySuggestions: process.advisorySuggestionsJson as any,
    processLint: process.processLintJson as any,
  };
}

export async function listAdviceProcesses(actor: AppActor, workspaceId: string, opts?: { status?: "GATHERING" | "READY" | "EXECUTED" | "WITHDRAWN" }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  return prisma.adviceProcess.findMany({
    where: {
      workspaceId,
      ...(opts?.status ? { status: opts.status } : {}),
    },
    include: {
      proposal: {
        select: { title: true, summary: true },
      },
      authorMember: {
        include: { user: { select: { displayName: true } } },
      },
      _count: {
        select: { records: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}
