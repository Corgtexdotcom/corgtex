import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
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
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
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
