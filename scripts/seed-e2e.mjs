import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (!databaseUrl || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)
    || databaseUrl.pathname !== "/corgtex_e2e" || process.env.MODEL_PROVIDER !== "fake") {
    throw new Error("E2E seed requires a local corgtex_e2e database and the fake model provider.");
  }
  const workspaceSlug = process.env.WORKSPACE_SLUG?.trim() || "corgtex";
  const email = (process.env.AGENT_E2E_EMAIL?.trim() || "system+corgtex@corgtex.local").toLowerCase();
  const password = process.env.AGENT_E2E_PASSWORD?.trim() || "corgtex-test-agent-pw";

  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    select: { id: true, slug: true },
  });

  if (!workspace) {
    throw new Error(`Workspace '${workspaceSlug}' not found. Run npm run prisma:seed first.`);
  }

  // The default CORE_FREE plan pauses model work. This isolated fixture must
  // permit fake-model calls for meeting, conversation, and worker checks.
  await prisma.$transaction([
    prisma.workspace.update({ where: { id: workspace.id }, data: { plan: "PAYG_AI" } }),
    prisma.modelUsageBudget.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id, monthlyCostCapUsd: 100 },
      update: { monthlyCostCapUsd: 100 },
    }),
  ]);

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  const user = existingUser
    ? await prisma.user.update({
        where: { email },
        data: {
          displayName: "E2E UI Testing Agent",
          passwordHash: hashPassword(password),
        },
      })
    : await prisma.user.create({
        data: {
          email,
          displayName: "E2E UI Testing Agent",
          passwordHash: hashPassword(password),
        },
      });

  await prisma.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id,
      },
    },
    update: {
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
    },
  });

  console.log(`Seeded E2E user '${email}' in workspace '${workspace.slug}'.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
