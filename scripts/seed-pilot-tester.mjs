import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

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

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function resolveWorkspace() {
  const workspaceId = optional("WORKSPACE_ID");
  const workspaceSlug = optional("WORKSPACE_SLUG");

  if (!workspaceId && !workspaceSlug) {
    throw new Error("Set WORKSPACE_ID or WORKSPACE_SLUG.");
  }

  const workspace = await prisma.workspace.findFirst({
    where: workspaceId ? { id: workspaceId } : { slug: workspaceSlug },
    select: { id: true, slug: true, name: true },
  });

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  return workspace;
}

async function main() {
  const workspace = await resolveWorkspace();
  const email = required("TESTER_EMAIL").toLowerCase();
  const password = required("TESTER_PASSWORD");
  const displayName = optional("TESTER_DISPLAY_NAME") ?? "Pilot Tester";

  if (password.length < 8) {
    throw new Error("TESTER_PASSWORD must be at least 8 characters.");
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      displayName,
      passwordHash: hashPassword(password),
    },
    create: {
      email,
      displayName,
      passwordHash: hashPassword(password),
    },
    select: { id: true, email: true },
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

  console.log(`Seeded tester ${user.email} as ADMIN for ${workspace.slug}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
