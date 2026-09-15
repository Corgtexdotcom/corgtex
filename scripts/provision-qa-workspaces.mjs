#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Explicit job only: never attach fixture refresh to web startup.
const expectedHost = process.env.QA_EXPECTED_DATABASE_HOST?.trim();
if (!expectedHost || new URL(process.env.DATABASE_URL).hostname !== expectedHost) {
  throw new Error("QA_EXPECTED_DATABASE_HOST must match the intended database before provisioning");
}
const prisma = new PrismaClient();
try {
  const workspaces = await prisma.workspace.findMany({
    where: { slug: { in: ["jnj-demo", "corgtex-validation"] } },
    select: { id: true, slug: true, name: true },
  });
  console.log(JSON.stringify({ phase: "preflight", databaseHost: expectedHost, workspaces }));
  if (process.argv.includes("--apply")) {
    if (!process.env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL?.trim()) {
      throw new Error("Set an explicit VALIDATION_BOOTSTRAP_ADMIN_EMAIL");
    }
    const memberEmail = process.env.QA_VALIDATION_MEMBER_EMAIL?.trim().toLowerCase();
    if (!memberEmail || !process.env.QA_VALIDATION_MEMBER_PASSWORD?.trim()) {
      throw new Error("Set QA_VALIDATION_MEMBER_EMAIL and QA_VALIDATION_MEMBER_PASSWORD for the ordinary QA account");
    }
    if (memberEmail === process.env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
      throw new Error("QA member and administrator must be separate identities");
    }
    const existingMember = await prisma.user.findUnique({ where: { email: memberEmail },
      select: { globalRole: true, memberships: { select: { workspace: { select: { slug: true } } } } },
    });
    if (existingMember && existingMember.globalRole !== "USER") {
      throw new Error("QA member must not have global operator access");
    }
    if (existingMember?.memberships.some((member) => member.workspace.slug !== "corgtex-validation")) {
      throw new Error("QA member must not belong to other workspaces");
    }
    if (process.env.SEED_RESET_PASSWORDS && process.env.SEED_RESET_PASSWORDS !== "false") {
      throw new Error("QA provisioning must preserve existing passwords");
    }
    for (const script of ["scripts/seed-internal-validation-workspace.mjs", "scripts/seed-jnj-demo.mjs"]) {
      const result = spawnSync(process.execPath, [script], { stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Provisioning failed: ${script}`);
    }
    const validation = await prisma.workspace.findUniqueOrThrow({ where: { slug: "corgtex-validation" } });
    const salt = randomBytes(16).toString("hex");
    const passwordHash = `scrypt$${salt}$${scryptSync(process.env.QA_VALIDATION_MEMBER_PASSWORD, salt, 64).toString("hex")}`;
    const memberUser = await prisma.user.upsert({ where: { email: memberEmail }, update: {},
      create: { email: memberEmail, displayName: "Validation QA Member", passwordHash, globalRole: "USER" },
    });
    await prisma.member.upsert({ where: { workspaceId_userId: { workspaceId: validation.id, userId: memberUser.id } },
      update: { role: "CONTRIBUTOR", isActive: true },
      create: { workspaceId: validation.id, userId: memberUser.id, role: "CONTRIBUTOR", isActive: true },
    });
    console.log(JSON.stringify({ phase: "provisioned", workspaces: await prisma.workspace.findMany({
      where: { slug: { in: ["jnj-demo", "corgtex-validation"] } },
      select: { id: true, slug: true, name: true },
    }) }));
  }
} finally {
  await prisma.$disconnect();
}
