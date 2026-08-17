import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import { pathToFileURL } from "node:url";

const prisma = new PrismaClient();
export const DEFAULT_E2E_VALIDATION_EMAIL = "e2e-validation@corgtex.local";

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export function selectSafeE2EValidationUser(email, matchingUsers) {
  if (/^system\+[^@]*@corgtex\.local$/i.test(email)) {
    throw new Error("AGENT_E2E_EMAIL must not use the reserved canonical system identity namespace.");
  }
  if (matchingUsers.some((user) => user.memberships.some((membership) => membership.kind === "SYSTEM"))) {
    throw new Error("AGENT_E2E_EMAIL resolves to a protected system member.");
  }
  if (matchingUsers.length > 1) {
    throw new Error("AGENT_E2E_EMAIL resolves to multiple case-insensitive user records.");
  }
  return matchingUsers[0] ?? null;
}

async function main() {
  const workspaceSlug = process.env.WORKSPACE_SLUG?.trim() || "corgtex";
  const email = (process.env.AGENT_E2E_EMAIL?.trim() || DEFAULT_E2E_VALIDATION_EMAIL).toLowerCase();
  const password = process.env.AGENT_E2E_PASSWORD?.trim() || "corgtex-test-agent-pw";

  const matchingUsers = await prisma.user.findMany({
    where: {
      email: {
        equals: email,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
      email: true,
      memberships: {
        select: { kind: true },
      },
    },
  });
  const existingUser = selectSafeE2EValidationUser(email, matchingUsers);

  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    select: { id: true, slug: true },
  });

  if (!workspace) {
    throw new Error(`Workspace '${workspaceSlug}' not found. Run npm run prisma:seed first.`);
  }

  const user = existingUser
    ? await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          displayName: "E2E Validation User",
          passwordHash: hashPassword(password),
        },
      })
    : await prisma.user.create({
        data: {
          email,
          displayName: "E2E Validation User",
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
      kind: "HUMAN",
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
      kind: "HUMAN",
      isActive: true,
    },
  });

  console.log(`Seeded E2E user '${email}' in workspace '${workspace.slug}'.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
