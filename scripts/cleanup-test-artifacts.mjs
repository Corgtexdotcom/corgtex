import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TEST_PREFIX = "[TEST]";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

async function resolveWorkspace() {
  const workspaceId = optional("WORKSPACE_ID");
  const workspaceSlug = optional("WORKSPACE_SLUG");

  if (!workspaceId && !workspaceSlug) {
    throw new Error("Set WORKSPACE_ID or WORKSPACE_SLUG.");
  }

  const workspace = await prisma.workspace.findFirst({
    where: workspaceId ? { id: workspaceId } : { slug: workspaceSlug },
    select: { id: true, slug: true },
  });

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  return workspace;
}

async function main() {
  const workspace = await resolveWorkspace();
  const testerEmail = required("TESTER_EMAIL").toLowerCase();
  const cleanupActorEmail = optional("CLEANUP_ACTOR_EMAIL")?.toLowerCase();

  const tester = await prisma.user.findUnique({
    where: { email: testerEmail },
    select: { id: true, email: true },
  });

  if (!tester) {
    throw new Error("Tester user not found.");
  }

  const cleanupActor = cleanupActorEmail
    ? await prisma.user.findUnique({
        where: { email: cleanupActorEmail },
        select: { id: true },
      })
    : null;

  const [proposals, tensions] = await Promise.all([
    prisma.proposal.findMany({
      where: {
        workspaceId: workspace.id,
        authorUserId: tester.id,
        title: { startsWith: TEST_PREFIX },
        status: { not: "ARCHIVED" },
      },
      select: { id: true, title: true, status: true },
    }),
    prisma.tension.findMany({
      where: {
        workspaceId: workspace.id,
        authorUserId: tester.id,
        title: { startsWith: TEST_PREFIX },
        status: { not: "CANCELLED" },
      },
      select: { id: true, title: true, status: true },
    }),
  ]);

  await prisma.$transaction(async (tx) => {
    for (const proposal of proposals) {
      await tx.proposal.update({
        where: { id: proposal.id },
        data: { status: "ARCHIVED" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: cleanupActor?.id ?? null,
          action: "test_artifact.proposal_archived",
          entityType: "Proposal",
          entityId: proposal.id,
          meta: {
            title: proposal.title,
            testerEmail: tester.email,
            testerUserId: tester.id,
            previousStatus: proposal.status,
          },
        },
      });
    }

    for (const tension of tensions) {
      await tx.tension.update({
        where: { id: tension.id },
        data: { status: "CANCELLED" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: cleanupActor?.id ?? null,
          action: "test_artifact.tension_cancelled",
          entityType: "Tension",
          entityId: tension.id,
          meta: {
            title: tension.title,
            testerEmail: tester.email,
            testerUserId: tester.id,
            previousStatus: tension.status,
          },
        },
      });
    }
  });

  console.log(`Archived ${proposals.length} proposals and cancelled ${tensions.length} tensions in ${workspace.slug}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
