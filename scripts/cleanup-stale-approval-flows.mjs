import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValue(name) {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : null;
}

async function resolveWorkspace(value) {
  if (!value) {
    throw new Error("Usage: node scripts/cleanup-stale-approval-flows.mjs --workspace <id-or-slug> [--apply]");
  }

  const workspace = await prisma.workspace.findFirst({
    where: {
      OR: [
        { id: value },
        { slug: value },
      ],
    },
    select: { id: true, slug: true, name: true },
  });

  if (!workspace) {
    throw new Error(`Workspace not found: ${value}`);
  }

  return workspace;
}

function staleReason(flow, proposalById, spendById) {
  if (flow.subjectType === "PROPOSAL") {
    const proposal = proposalById.get(flow.subjectId);
    if (!proposal) return "proposal missing";
    if (proposal.archivedAt) return "proposal archived";
    if (proposal.status !== "OPEN") return `proposal status ${proposal.status}`;
    if (proposal.isPrivate) return "proposal private";
    return null;
  }

  if (flow.subjectType === "SPEND") {
    const spend = spendById.get(flow.subjectId);
    if (!spend) return "spend missing";
    if (spend.archivedAt) return "spend archived";
    if (spend.status !== "OPEN") return `spend status ${spend.status}`;
    return null;
  }

  return `unsupported subject type ${flow.subjectType}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const workspace = await resolveWorkspace(argValue("--workspace"));
  const flows = await prisma.approvalFlow.findMany({
    where: { workspaceId: workspace.id, status: "ACTIVE" },
    select: { id: true, subjectType: true, subjectId: true },
    orderBy: { createdAt: "asc" },
  });
  const proposalIds = flows.filter((flow) => flow.subjectType === "PROPOSAL").map((flow) => flow.subjectId);
  const spendIds = flows.filter((flow) => flow.subjectType === "SPEND").map((flow) => flow.subjectId);
  const [proposals, spends] = await Promise.all([
    proposalIds.length > 0
      ? prisma.proposal.findMany({
        where: { id: { in: proposalIds } },
        select: { id: true, status: true, isPrivate: true, archivedAt: true },
      })
      : Promise.resolve([]),
    spendIds.length > 0
      ? prisma.spendRequest.findMany({
        where: { id: { in: spendIds } },
        select: { id: true, status: true, archivedAt: true },
      })
      : Promise.resolve([]),
  ]);
  const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const spendById = new Map(spends.map((spend) => [spend.id, spend]));
  const stale = flows
    .map((flow) => ({ flow, reason: staleReason(flow, proposalById, spendById) }))
    .filter((entry) => entry.reason);

  if (!apply) {
    console.log(JSON.stringify({
      dryRun: true,
      workspace: workspace.slug,
      activeFlows: flows.length,
      staleFlows: stale.length,
      reasons: stale.reduce((acc, entry) => {
        acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
        return acc;
      }, {}),
    }, null, 2));
    return;
  }

  const now = new Date();
  let withdrawn = 0;
  for (const { flow, reason } of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.approvalFlow.update({
        where: { id: flow.id },
        data: {
          status: "WITHDRAWN",
          closedAt: now,
          resultJson: {
            cleanupReason: reason,
            subjectType: flow.subjectType,
            subjectId: flow.subjectId,
            withdrawnAt: now.toISOString(),
          },
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: null,
          action: "approval.withdrawn",
          entityType: "ApprovalFlow",
          entityId: flow.id,
          meta: {
            cleanupReason: reason,
            subjectType: flow.subjectType,
            subjectId: flow.subjectId,
            script: "cleanup-stale-approval-flows",
          },
        },
      });
    });
    withdrawn += 1;
  }

  console.log(JSON.stringify({
    dryRun: false,
    workspace: workspace.slug,
    activeFlows: flows.length,
    staleFlows: stale.length,
    withdrawn,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
