#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { INTERNAL_VALIDATION_WORKSPACE_NAME, INTERNAL_VALIDATION_WORKSPACE_SLUG } from "./lib/validation-workspace.mjs";

export const ADOPTION_ACTION = "internal_validation_workspace.support_owner_adopted";
const SEED_ACTION = "internal_validation_workspace.seeded";
const required = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Set ${name}`);
  return value.trim();
};

export function adoptionConfig(env, argv, build) {
  if (argv.some(arg => arg !== "--apply") || argv.length > 1) throw new Error("Use no arguments for preflight, or --apply");
  const apply = argv.includes("--apply");
  const releaseSha = required(env.QA_EXPECTED_RELEASE_SHA, "QA_EXPECTED_RELEASE_SHA");
  if (!/^[a-f0-9]{40}$/.test(releaseSha) || build?.role !== "web" || build.gitSha !== releaseSha) {
    throw new Error("Adoption image must contain the expected web release build");
  }
  const database = new URL(required(env.DATABASE_URL, "DATABASE_URL"));
  const databaseHost = required(env.QA_EXPECTED_DATABASE_HOST, "QA_EXPECTED_DATABASE_HOST");
  const databaseName = required(env.QA_EXPECTED_DATABASE_NAME, "QA_EXPECTED_DATABASE_NAME");
  const databaseSchema = required(env.QA_EXPECTED_DATABASE_SCHEMA, "QA_EXPECTED_DATABASE_SCHEMA");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== databaseHost
    || decodeURIComponent(database.pathname.slice(1)) !== databaseName || (database.searchParams.get("schema") || "public") !== databaseSchema) {
    throw new Error("Confirmed database host/name/schema must match DATABASE_URL");
  }
  const adminEmail = required(env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL, "VALIDATION_BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const expectedWorkspaceId = env.QA_EXPECTED_VALIDATION_WORKSPACE_ID?.trim() || null;
  const expectedAdminUserId = env.QA_EXPECTED_VALIDATION_ADMIN_USER_ID?.trim() || null;
  let execution = null;
  if (apply) {
    required(expectedWorkspaceId, "QA_EXPECTED_VALIDATION_WORKSPACE_ID");
    required(expectedAdminUserId, "QA_EXPECTED_VALIDATION_ADMIN_USER_ID");
    execution = Object.fromEntries([
      ["actor", "QA_EXECUTION_ACTOR"], ["initiator", "QA_EXECUTION_INITIATOR"],
      ["repository", "QA_EXECUTION_REPOSITORY"], ["runId", "QA_EXECUTION_RUN_ID"],
      ["runAttempt", "QA_EXECUTION_RUN_ATTEMPT"], ["workflowRef", "QA_EXECUTION_WORKFLOW_REF"],
    ].map(([key, name]) => [key, required(env[name], name)]));
    if (execution.repository !== "Corgtexdotcom/corgtex"
      || execution.workflowRef !== "Corgtexdotcom/corgtex/.github/workflows/qa-workspaces.yml@refs/heads/main"
      || !/^[1-9][0-9]*$/.test(execution.runId) || !/^[1-9][0-9]*$/.test(execution.runAttempt)
      || !/^[a-zA-Z0-9_\[\]-]+$/.test(execution.actor) || !/^[a-zA-Z0-9_\[\]-]+$/.test(execution.initiator)) {
      throw new Error("Apply requires the protected QA workflow execution identity");
    }
    execution = { kind: "github-actions", ...execution, job: "provision", releaseSha };
  }
  return { apply, releaseSha, databaseHost, databaseName, databaseSchema, adminEmail, expectedWorkspaceId, expectedAdminUserId, execution };
}

export async function adoptValidationSupportOwner(prisma, config) {
  return prisma.$transaction(async tx => {
    if (!config.apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw`SELECT current_database() AS "databaseName", current_schema() AS "schema"`;
    if (identity.databaseName !== config.databaseName || identity.schema !== config.databaseSchema) {
      throw new Error("Connected database identity does not match the confirmed target");
    }
    // Match the support API's workspace lock; lock the user and memberships too so
    // identity, role, and FK-backed access checks cannot change during adoption.
    if (config.apply) await tx.$queryRaw`SELECT id FROM "Workspace" WHERE slug = ${INTERNAL_VALIDATION_WORKSPACE_SLUG} FOR UPDATE`;
    const workspace = await tx.workspace.findUnique({ where: { slug: INTERNAL_VALIDATION_WORKSPACE_SLUG }, select: { id: true, slug: true, name: true, supportOwnerUserId: true } });
    if (!workspace || workspace.name !== INTERNAL_VALIDATION_WORKSPACE_NAME) throw new Error("Existing seeded internal validation workspace required");
    if (config.expectedWorkspaceId && workspace.id !== config.expectedWorkspaceId) throw new Error("Expected validation workspace ID does not match");
    if (config.apply) await tx.$queryRaw`SELECT id FROM "User" WHERE email = ${config.adminEmail} FOR UPDATE`;
    const admin = await tx.user.findUnique({ where: { email: config.adminEmail }, select: { id: true, email: true, globalRole: true, isSupportAccount: true } });
    if (!admin || admin.globalRole !== "USER" || admin.isSupportAccount) throw new Error("Existing dedicated global USER validation admin required");
    if (config.expectedAdminUserId && admin.id !== config.expectedAdminUserId) throw new Error("Expected validation admin user ID does not match");
    if (config.apply) await tx.$queryRaw`SELECT id FROM "Member" WHERE "userId" = ${admin.id} FOR UPDATE`;
    const memberships = await tx.member.findMany({ where: { userId: admin.id }, select: { workspaceId: true, role: true, kind: true, isActive: true } });
    if (memberships.length !== 1 || memberships[0].workspaceId !== workspace.id || !memberships[0].isActive
      || memberships[0].role !== "ADMIN" || memberships[0].kind !== "HUMAN") {
      throw new Error("Validation admin must be an active HUMAN ADMIN with no other workspace membership");
    }
    if (await tx.workspaceSupportGrant.count({ where: { userId: admin.id } })
      || await tx.workspace.count({ where: { supportOwnerUserId: admin.id, id: { not: workspace.id } } })) {
      throw new Error("Validation admin must have no support grants or other workspace ownership");
    }
    if (config.apply) await tx.$queryRaw`SELECT id FROM "AuditLog" WHERE "workspaceId" = ${workspace.id} AND action = ${SEED_ACTION} FOR SHARE`;
    const provenance = await tx.auditLog.findMany({ where: { workspaceId: workspace.id, action: SEED_ACTION }, select: { id: true, actorUserId: true, entityType: true, entityId: true, meta: true } });
    if (provenance.length !== 1 || provenance[0].actorUserId !== admin.id || provenance[0].entityType !== "Workspace"
      || provenance[0].entityId !== workspace.id || provenance[0].meta?.sampleDataSeeded !== true) {
      throw new Error("Validation seed provenance must identify this existing admin and workspace");
    }
    if (workspace.supportOwnerUserId && workspace.supportOwnerUserId !== admin.id) throw new Error("A different support owner is already assigned; never overwrite it");
    const status = workspace.supportOwnerUserId === admin.id ? "already-owned" : config.apply ? "adopted" : "ready";
    if (config.apply && status === "adopted") {
      const updated = await tx.workspace.updateMany({ where: { id: workspace.id, slug: INTERNAL_VALIDATION_WORKSPACE_SLUG, supportOwnerUserId: null }, data: { supportOwnerUserId: admin.id } });
      if (updated.count !== 1) throw new Error("Validation owner changed; inspect before retrying");
      // The operator is the protected job, not the human being assigned ownership.
      await tx.auditLog.create({ data: {
        workspaceId: workspace.id, actorUserId: null, action: ADOPTION_ACTION,
        entityType: "Workspace", entityId: workspace.id,
        meta: { previousOwnerUserId: null, ownerUserId: admin.id, seedAuditId: provenance[0].id, execution: config.execution },
      } });
    }
    return { operation: "adopt-validation-owner", mode: config.apply ? "apply" : "preflight", status,
      workspaceId: workspace.id, workspaceSlug: workspace.slug, adminUserId: admin.id, adminEmail: admin.email,
      currentOwnerUserId: config.apply ? admin.id : workspace.supportOwnerUserId, seedAuditId: provenance[0].id,
      releaseSha: config.releaseSha, databaseHost: config.databaseHost, databaseName: config.databaseName, databaseSchema: config.databaseSchema };
  }, { isolationLevel: config.apply ? "Serializable" : "RepeatableRead", timeout: 15000 });
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const build = JSON.parse(readFileSync(new URL("../release-build.json", import.meta.url), "utf8"));
  const config = adoptionConfig(env, argv, build);
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try { console.log(JSON.stringify(await adoptValidationSupportOwner(prisma, config))); }
  finally { await prisma.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { console.error(`[adopt-validation-support-owner] ${error.message}`); process.exitCode = 1; }
}
