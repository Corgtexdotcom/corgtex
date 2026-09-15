#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { validationEmails } from "./lib/qa-identities.mjs";

// Explicit job only: never attach fixture refresh to web startup.
const expectedHost = process.env.QA_EXPECTED_DATABASE_HOST?.trim();
if (!expectedHost || new URL(process.env.DATABASE_URL).hostname !== expectedHost) {
  throw new Error("QA_EXPECTED_DATABASE_HOST must match the intended database before provisioning");
}
const database = new URL(process.env.DATABASE_URL);
if (!process.env.QA_EXPECTED_DATABASE_NAME || decodeURIComponent(database.pathname.slice(1)) !== process.env.QA_EXPECTED_DATABASE_NAME
  || !process.env.QA_EXPECTED_DATABASE_SCHEMA || (database.searchParams.get("schema") || "public") !== process.env.QA_EXPECTED_DATABASE_SCHEMA) {
  throw new Error("Confirm QA_EXPECTED_DATABASE_NAME and QA_EXPECTED_DATABASE_SCHEMA before provisioning");
}
const prisma = new PrismaClient();
try {
  const [identity] = await prisma.$queryRaw`SELECT current_database() AS "databaseName", current_schema() AS "schema"`;
  if (identity.databaseName !== process.env.QA_EXPECTED_DATABASE_NAME || identity.schema !== process.env.QA_EXPECTED_DATABASE_SCHEMA) {
    throw new Error("Connected database identity does not match the confirmed target");
  }
  const workspaces = await prisma.workspace.findMany({
    where: { slug: { in: ["jnj-demo", "corgtex-validation"] } },
    select: { id: true, slug: true, name: true },
  });
  console.log(JSON.stringify({ phase: "preflight", databaseHost: expectedHost, databaseName: process.env.QA_EXPECTED_DATABASE_NAME, schema: process.env.QA_EXPECTED_DATABASE_SCHEMA, workspaces }));
  if (process.argv.includes("--apply")) {
    for (const [slug, variable] of [["jnj-demo", "QA_EXPECTED_DEMO_WORKSPACE_ID"], ["corgtex-validation", "QA_EXPECTED_VALIDATION_WORKSPACE_ID"]]) {
      const workspace = workspaces.find((item) => item.slug === slug);
      const expectedId = process.env[variable];
      if ((workspace || expectedId) && expectedId !== workspace?.id) {
        throw new Error(`Confirm ${variable} from the inventory before refreshing fixtures`);
      }
    }
    const { adminEmail, memberEmail } = validationEmails(process.env);
    process.env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL = adminEmail;
    if (!process.env.QA_VALIDATION_MEMBER_PASSWORD?.trim()) {
      throw new Error("Set QA_VALIDATION_MEMBER_PASSWORD for the ordinary QA account");
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
