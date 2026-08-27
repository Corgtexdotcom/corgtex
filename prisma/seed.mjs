import { PrismaClient } from "@prisma/client";
import {
  assertNonReservedWorkspaceSystemEmail,
  ensureCanonicalWorkspace,
} from "../packages/domain/src/workspaces.ts";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function upsertOperatorUser(params) {
  const existingUser = await prisma.user.findUnique({
    where: { email: params.email },
    select: { id: true },
  });
  const shouldSetPassword = params.resetPasswords || !existingUser;
  if (shouldSetPassword && !params.password) {
    throw new Error(`Missing required environment variable: ${params.passwordEnvName}`);
  }

  if (existingUser) {
    return prisma.user.update({
      where: { email: params.email },
      data: {
        displayName: params.displayName,
        globalRole: "OPERATOR",
        ...(params.resetPasswords ? { passwordHash: hashPassword(params.password) } : {}),
      },
    });
  }

  return prisma.user.create({
    data: {
      email: params.email,
      displayName: params.displayName,
      passwordHash: hashPassword(params.password),
      globalRole: "OPERATOR",
    },
  });
}

async function main() {
  const adminEmail = required("ADMIN_EMAIL").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  const resetPasswords = process.env.SEED_RESET_PASSWORDS?.trim().toLowerCase() === "true";
  const workspaceName = process.env.WORKSPACE_NAME?.trim() || "Corgtex";
  const workspaceSlug = process.env.WORKSPACE_SLUG?.trim() || "corgtex";
  const controlPlaneTesterEmail = process.env.CONTROL_PLANE_TESTER_EMAIL?.trim().toLowerCase();
  const controlPlaneTesterPassword = process.env.CONTROL_PLANE_TESTER_PASSWORD?.trim();
  const controlPlaneTesterDisplayName = process.env.CONTROL_PLANE_TESTER_DISPLAY_NAME?.trim() || "Control Plane Test Operator";
  assertNonReservedWorkspaceSystemEmail(adminEmail);
  if (controlPlaneTesterEmail) {
    assertNonReservedWorkspaceSystemEmail(controlPlaneTesterEmail);
  }

  const workspace = await prisma.$transaction((tx) => ensureCanonicalWorkspace(tx, {
    slug: workspaceSlug,
    name: workspaceName,
    description: "Default workspace for Corgtex.",
    update: { name: workspaceName },
  }));

  const existingAdminUser = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true },
  });
  const shouldSetAdminPassword = resetPasswords || !existingAdminUser;
  if (shouldSetAdminPassword && !adminPassword) {
    throw new Error("Missing required environment variable: ADMIN_PASSWORD");
  }

  const adminUser = existingAdminUser
    ? await prisma.user.update({
        where: { email: adminEmail },
        data: {
          displayName: "Admin",
          globalRole: "OPERATOR",
          ...(resetPasswords ? { passwordHash: hashPassword(adminPassword) } : {}),
        },
      })
    : await prisma.user.create({
        data: {
          email: adminEmail,
          displayName: "Admin",
          passwordHash: hashPassword(adminPassword),
          globalRole: "OPERATOR",
        },
      });

  await prisma.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: adminUser.id,
      },
    },
    update: {
      role: "ADMIN",
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: adminUser.id,
      role: "ADMIN",
      isActive: true,
    },
  });

  if (controlPlaneTesterEmail) {
    if (controlPlaneTesterEmail === adminEmail) {
      throw new Error("CONTROL_PLANE_TESTER_EMAIL must be different from ADMIN_EMAIL so production testing remains auditable.");
    }

    await upsertOperatorUser({
      email: controlPlaneTesterEmail,
      password: controlPlaneTesterPassword,
      passwordEnvName: "CONTROL_PLANE_TESTER_PASSWORD",
      displayName: controlPlaneTesterDisplayName,
      resetPasswords,
    });
  }

  await prisma.circle.upsert({
    where: { id: `${workspace.id}-general-circle` },
    update: {
      name: "General",
      workspaceId: workspace.id,
    },
    create: {
      id: `${workspace.id}-general-circle`,
      workspaceId: workspace.id,
      name: "General",
      purposeMd: "Shared operating circle for the workspace.",
    },
  });

  const constitutionBody = `# Workspace Constitution

This is the authoritative document defining the operating principles of our organization.

## AI Manager Guidelines
- The AI Manager shall prioritize organization health and governance compliance.
- All decisions should be transparent and documented.
- The AI Manager operates under the Consent mode by default.`;

  await prisma.constitution.upsert({
    where: { 
      workspaceId_version: {
        workspaceId: workspace.id,
        version: 1
      }
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      version: 1,
      bodyMd: constitutionBody,
      modelUsed: "system_seed",
    }
  });

  await prisma.brainArticle.upsert({
    where: {
      workspaceId_slug: {
        workspaceId: workspace.id,
        slug: "ai-manager-constitution"
      }
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      slug: "ai-manager-constitution",
      title: "AI Manager Constitution",
      type: "PATTERN",
      authority: "AUTHORITATIVE",
      bodyMd: constitutionBody,
    }
  });

  console.log(
    `Seeded workspace '${workspace.slug}' with admin '${adminEmail}'${
      controlPlaneTesterEmail ? ` and control-plane tester '${controlPlaneTesterEmail}'` : ""
    } (passwords ${resetPasswords ? "reset" : "preserved"}).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
