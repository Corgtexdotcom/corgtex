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

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
  const adminEmail = required("ADMIN_EMAIL").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  const resetPasswords = process.env.SEED_RESET_PASSWORDS?.trim().toLowerCase() === "true";
  const workspaceName = process.env.WORKSPACE_NAME?.trim() || "Corgtex";
  const workspaceSlug = process.env.WORKSPACE_SLUG?.trim() || "corgtex";

  const workspace = await prisma.workspace.upsert({
    where: { slug: workspaceSlug },
    update: { name: workspaceName },
    create: {
      slug: workspaceSlug,
      name: workspaceName,
      description: "Default workspace for Corgtex.",
    },
  });

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

  const systemEmail = `system+${workspace.slug}@corgtex.local`;
  const existingSystemUser = await prisma.user.findUnique({
    where: { email: systemEmail },
    select: { id: true },
  });
  const shouldSetSystemPassword = resetPasswords || !existingSystemUser;
  if (shouldSetSystemPassword && !adminPassword) {
    throw new Error("Missing required environment variable: ADMIN_PASSWORD");
  }

  const systemUser = existingSystemUser
    ? await prisma.user.update({
        where: { email: systemEmail },
        data: {
          displayName: `${workspace.name} System`,
          ...(resetPasswords ? { passwordHash: hashPassword(adminPassword) } : {}),
        },
      })
    : await prisma.user.create({
        data: {
          email: systemEmail,
          displayName: `${workspace.name} System`,
          passwordHash: hashPassword(adminPassword),
        },
      });

  await prisma.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: systemUser.id,
      },
    },
    update: {
      role: "ADMIN",
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: systemUser.id,
      role: "ADMIN",
      isActive: true,
    },
  });

  await prisma.approvalPolicy.upsert({
    where: {
      workspaceId_subjectType: {
        workspaceId: workspace.id,
        subjectType: "PROPOSAL",
      },
    },
    update: {
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
    create: {
      workspaceId: workspace.id,
      subjectType: "PROPOSAL",
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
  });

  await prisma.approvalPolicy.upsert({
    where: {
      workspaceId_subjectType: {
        workspaceId: workspace.id,
        subjectType: "SPEND",
      },
    },
    update: {
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
    create: {
      workspaceId: workspace.id,
      subjectType: "SPEND",
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
  });

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
    `Seeded workspace '${workspace.slug}' with admin '${adminEmail}' (passwords ${
      resetPasswords ? "reset" : "preserved"
    }).`,
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
