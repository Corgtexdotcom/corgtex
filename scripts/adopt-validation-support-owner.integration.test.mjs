import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { ADOPTION_ACTION, adoptionConfig, adoptValidationSupportOwner } from "./adopt-validation-support-owner.mjs";
import { INTERNAL_VALIDATION_WORKSPACE_NAME, INTERNAL_VALIDATION_WORKSPACE_SLUG } from "./lib/validation-workspace.mjs";

// This suite writes fixtures only to an explicitly supplied, local test database.
const url = new URL(process.env.QA_OWNER_TEST_DATABASE_URL || "http://missing");
if (!["localhost", "127.0.0.1"].includes(url.hostname)
  || !["/corgtex_test", "/corgtex_owner_adoption_test"].includes(url.pathname)
  || !["postgres:", "postgresql:"].includes(url.protocol)) {
  throw new Error("Set QA_OWNER_TEST_DATABASE_URL to an isolated local corgtex_test or corgtex_owner_adoption_test database");
}
const prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
const sha = "a".repeat(40);
const userIds = [], workspaceIds = [];
let workspace, admin, member, provenance, env;
const config = (apply = true, overrides = {}) => adoptionConfig({ ...env, ...overrides }, apply ? ["--apply"] : [], { role: "web", gitSha: sha });
const adopt = (apply = true, overrides = {}, client = prisma) => adoptValidationSupportOwner(client, config(apply, overrides));
async function newUser() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@validation.invalid`, passwordHash: "synthetic-no-login", globalRole: "USER" } });
  userIds.push(user.id);
  return user;
}
async function otherWorkspace(data = {}) {
  const row = await prisma.workspace.create({ data: { slug: `synthetic-${randomUUID()}`, name: "Other synthetic workspace", ...data } });
  workspaceIds.push(row.id);
  return row;
}
async function unchanged() {
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).supportOwnerUserId, null);
  assert.equal(await prisma.auditLog.count({ where: { workspaceId: workspace.id, action: ADOPTION_ACTION } }), 0);
}

function atLock(table, phase, hook) {
  return { $transaction: (fn, options) => prisma.$transaction(tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key !== "$queryRaw") return Reflect.get(target, key);
      return async (...args) => {
        const matches = args[0].join("").includes(`FROM "${table}"`);
        if (matches && phase === "before") await hook();
        const result = await target.$queryRaw(...args);
        if (matches && phase === "after") await hook();
        return result;
      };
    },
  })), options) };
}

describe("internal validation owner adoption on migrated PostgreSQL", { concurrency: false }, () => {
  before(async () => {
    assert.equal(await prisma.workspace.count({ where: { slug: INTERNAL_VALIDATION_WORKSPACE_SLUG } }), 0, "Refuse to touch a pre-existing validation fixture");
  });
  beforeEach(async () => {
    admin = await newUser();
    workspace = await prisma.workspace.create({ data: { slug: INTERNAL_VALIDATION_WORKSPACE_SLUG, name: INTERNAL_VALIDATION_WORKSPACE_NAME } });
    workspaceIds.push(workspace.id);
    member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: admin.id, role: "ADMIN", kind: "HUMAN", isActive: true } });
    // Exact audit shape emitted by client-stable-seed using validationSeedConfig.
    provenance = await prisma.auditLog.create({ data: { workspaceId: workspace.id, actorUserId: admin.id,
      action: "internal_validation_workspace.seeded", entityType: "Workspace", entityId: workspace.id,
      meta: { defaultLocale: "en", sampleDataSeeded: true, featureFlags: {} } } });
    env = { DATABASE_URL: url.href, QA_EXPECTED_DATABASE_HOST: url.hostname,
      QA_EXPECTED_DATABASE_NAME: decodeURIComponent(url.pathname.slice(1)), QA_EXPECTED_DATABASE_SCHEMA: url.searchParams.get("schema") || "public",
      QA_EXPECTED_RELEASE_SHA: sha, VALIDATION_BOOTSTRAP_ADMIN_EMAIL: admin.email,
      QA_EXPECTED_VALIDATION_WORKSPACE_ID: workspace.id, QA_EXPECTED_VALIDATION_ADMIN_USER_ID: admin.id,
      QA_EXECUTION_ACTOR: "synthetic-job-operator", QA_EXECUTION_INITIATOR: "synthetic-dispatcher",
      QA_EXECUTION_REPOSITORY: "Corgtexdotcom/corgtex", QA_EXECUTION_RUN_ID: "123", QA_EXECUTION_RUN_ATTEMPT: "1",
      QA_EXECUTION_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/qa-workspaces.yml@refs/heads/main" };
  });
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds.splice(0) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  });
  after(async () => { await prisma.$disconnect(); });

  it("preflights without IDs and performs zero persistent writes", async () => {
    const beforeWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    assert.equal((await adopt(false, { QA_EXPECTED_VALIDATION_WORKSPACE_ID: undefined, QA_EXPECTED_VALIDATION_ADMIN_USER_ID: undefined })).status, "ready");
    await unchanged();
    assert.deepEqual(await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }), beforeWorkspace);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    assert.deepEqual(await prisma.member.findUniqueOrThrow({ where: { id: member.id } }), member);
  });

  it("changes only ownership and an operator-attributed audit, then is idempotent", async () => {
    assert.equal((await adopt()).status, "adopted");
    const owned = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    assert.equal(owned.supportOwnerUserId, admin.id);
    const { updatedAt: _beforeTime, supportOwnerUserId: _beforeOwner, ...beforeFields } = workspace;
    const { updatedAt: _afterTime, supportOwnerUserId: _afterOwner, ...afterFields } = owned;
    assert.deepEqual(afterFields, beforeFields);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    assert.deepEqual(await prisma.member.findUniqueOrThrow({ where: { id: member.id } }), member);
    assert.deepEqual(await prisma.auditLog.findUniqueOrThrow({ where: { id: provenance.id } }), provenance);
    for (const model of ["workspaceSupportGrant", "passwordResetToken", "session", "agentCredential"]) {
      assert.equal(await prisma[model].count({ where: model === "agentCredential" ? { createdByUserId: admin.id } : { userId: admin.id } }), 0);
    }
    const audits = await prisma.auditLog.findMany({ where: { action: ADOPTION_ACTION, workspaceId: workspace.id } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUserId, null);
    assert.equal(audits[0].meta.ownerUserId, admin.id);
    assert.equal(audits[0].meta.seedAuditId, provenance.id);
    assert.equal(audits[0].meta.execution.actor, "synthetic-job-operator");
    assert.equal(audits[0].meta.execution.runId, "123");
    assert.equal((await adopt()).status, "already-owned");
    assert.equal((await adopt(false)).status, "already-owned");
    assert.equal(await prisma.auditLog.count({ where: { action: ADOPTION_ACTION, workspaceId: workspace.id } }), 1);
    assert.deepEqual(await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }), owned);
  });

  for (const [name, mutate] of [
    ["global operator", () => prisma.user.update({ where: { id: admin.id }, data: { globalRole: "OPERATOR" } })],
    ["retired support identity", () => prisma.user.update({ where: { id: admin.id }, data: { isSupportAccount: true } })],
    ["inactive admin", () => prisma.member.update({ where: { id: member.id }, data: { isActive: false } })],
    ["non-admin", () => prisma.member.update({ where: { id: member.id }, data: { role: "CONTRIBUTOR" } })],
    ["non-human", () => prisma.member.update({ where: { id: member.id }, data: { kind: "SYSTEM" } })],
    ["missing membership", () => prisma.member.delete({ where: { id: member.id } })],
    ["other inactive membership", async () => { const w = await otherWorkspace(); await prisma.member.create({ data: { workspaceId: w.id, userId: admin.id, isActive: false } }); }],
    ["other workspace ownership", () => otherWorkspace({ supportOwnerUserId: admin.id })],
    ["inactive support grant", () => prisma.workspaceSupportGrant.create({ data: { workspaceId: workspace.id, userId: admin.id, grantedByUserId: admin.id, role: "SETUP", isActive: false } })],
    ["outside support grant", async () => { const w = await otherWorkspace(); await prisma.workspaceSupportGrant.create({ data: { workspaceId: w.id, userId: admin.id, grantedByUserId: admin.id, role: "FULL" } }); }],
    ["missing provenance", () => prisma.auditLog.delete({ where: { id: provenance.id } })],
    ["wrong seed admin", async () => { const user = await newUser(); await prisma.auditLog.update({ where: { id: provenance.id }, data: { actorUserId: user.id } }); }],
    ["wrong seed entity", () => prisma.auditLog.update({ where: { id: provenance.id }, data: { entityId: "other" } })],
    ["missing synthetic seed evidence", () => prisma.auditLog.update({ where: { id: provenance.id }, data: { meta: { sampleDataSeeded: false } } })],
    ["ambiguous seed evidence", () => prisma.auditLog.create({ data: { workspaceId: workspace.id, actorUserId: admin.id, action: provenance.action, entityType: "Workspace", entityId: workspace.id, meta: { sampleDataSeeded: true } } })],
    ["renamed workspace", () => prisma.workspace.update({ where: { id: workspace.id }, data: { name: "Customer tenant" } })],
    ["customer slug", () => prisma.workspace.update({ where: { id: workspace.id }, data: { slug: "customer-tenant" } })],
  ]) {
    it(`refuses ${name} without adopting`, async () => {
      await mutate();
      await assert.rejects(adopt());
      await unchanged();
    });
  }

  it("refuses wrong reviewed IDs, nonexistent admin and connected database mismatch", async () => {
    for (const overrides of [{ QA_EXPECTED_VALIDATION_WORKSPACE_ID: "other" }, { QA_EXPECTED_VALIDATION_ADMIN_USER_ID: "other" }, { VALIDATION_BOOTSTRAP_ADMIN_EMAIL: "absent@validation.invalid" }]) await assert.rejects(adopt(true, overrides));
    await assert.rejects(adoptValidationSupportOwner(prisma, { ...config(), databaseName: "other" }), /Connected database/);
    await unchanged();
  });

  it("never overwrites a different owner", async () => {
    const other = await newUser();
    await prisma.workspace.update({ where: { id: workspace.id }, data: { supportOwnerUserId: other.id } });
    await assert.rejects(adopt(), /different support owner/);
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).supportOwnerUserId, other.id);
  });

  it("rolls back ownership if the audit fails", async () => {
    const failing = { $transaction: (fn, options) => prisma.$transaction(tx => fn(new Proxy(tx, {
      get(target, key) { return key === "auditLog" ? { ...target.auditLog, create: async () => { throw new Error("synthetic audit failure"); } } : Reflect.get(target, key); },
    })), options) };
    await assert.rejects(adopt(true, {}, failing), /synthetic audit failure/);
    await unchanged();
  });

  for (const kind of ["membership", "support grant"]) {
    it(`refuses an outside ${kind} committed after the initial snapshot but before parent locks`, async () => {
      const outside = await otherWorkspace();
      let inserted = false;
      const interleaved = { $transaction: (fn, options) => prisma.$transaction(tx => fn(new Proxy(tx, {
        get(target, key) {
          if (key !== "$queryRaw") return Reflect.get(target, key);
          return async (...args) => {
            const result = await target.$queryRaw(...args);
            if (args[0].join("").includes("current_database()")) {
              // A separate READ COMMITTED transaction commits before adoption locks
              // either parent; the original Serializable snapshot cannot see it.
              await prisma.$transaction(async writer => {
                if (kind === "membership") {
                  await writer.member.create({ data: { workspaceId: outside.id, userId: admin.id, isActive: false } });
                } else {
                  await writer.workspaceSupportGrant.create({ data: { workspaceId: outside.id, userId: admin.id, grantedByUserId: admin.id, role: "FULL" } });
                }
              }, { isolationLevel: "ReadCommitted" });
              inserted = true;
            }
            return result;
          };
        },
      })), options) };
      await assert.rejects(adopt(true, {}, interleaved), kind === "membership" ? /no other workspace membership/ : /no support grants/);
      assert.equal(inserted, true);
      await unchanged();
    });
  }

  for (const [name, table, mutate, error] of [
    ["member deactivation", "Member", tx => tx.member.update({ where: { id: member.id }, data: { isActive: false } }), /active HUMAN ADMIN/],
    ["member reassignment", "Member", async tx => { const other = await newUser(); await tx.member.update({ where: { id: member.id }, data: { userId: other.id } }); }, /active HUMAN ADMIN/],
    ["seed update", "AuditLog", tx => tx.auditLog.update({ where: { id: provenance.id }, data: { meta: { sampleDataSeeded: false } } }), /seed provenance/],
    ["seed deletion", "AuditLog", tx => tx.auditLog.delete({ where: { id: provenance.id } }), /seed provenance/],
  ]) {
    it(`rejects ${name} committed before its child lock`, async () => {
      const client = atLock(table, "before", () => prisma.$transaction(mutate, { isolationLevel: "ReadCommitted" }));
      await assert.rejects(adopt(true, {}, client), error);
      await unchanged();
    });
  }

  for (const [name, table, mutation] of [
    ["incoming membership", "User", (tx, outside) => tx.member.create({ data: { workspaceId: outside.id, userId: admin.id } })],
    ["incoming support grant", "User", (tx, outside) => tx.workspaceSupportGrant.create({ data: { workspaceId: outside.id, userId: admin.id, grantedByUserId: admin.id, role: "SETUP" } })],
    ["other ownership", "User", (tx, outside) => tx.workspace.update({ where: { id: outside.id }, data: { supportOwnerUserId: admin.id } })],
    ["member deactivation", "Member", tx => tx.member.update({ where: { id: member.id }, data: { isActive: false } })],
    ["member reassignment", "Member", (tx, _outside, other) => tx.member.update({ where: { id: member.id }, data: { userId: other.id } })],
    ["seed update", "AuditLog", tx => tx.auditLog.update({ where: { id: provenance.id }, data: { meta: { sampleDataSeeded: false } } })],
    ["seed deletion", "AuditLog", tx => tx.auditLog.delete({ where: { id: provenance.id } })],
    ["duplicate seed insertion", "Workspace", tx => tx.auditLog.create({ data: { workspaceId: workspace.id, actorUserId: admin.id, action: provenance.action, entityType: "Workspace", entityId: workspace.id, meta: { sampleDataSeeded: true } } })],
  ]) {
    it(`blocks ${name} until adoption releases its ${table} lock`, async () => {
      const outside = await otherWorkspace();
      const other = await newUser();
      let writer, blocked = false;
      const client = atLock(table, "after", async () => {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        writer = prisma.$transaction(async tx => {
          const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
          started(row.pid);
          await mutation(tx, outside, other);
        }, { isolationLevel: "ReadCommitted", timeout: 10000 }).then(() => null, error => error);
        const pid = await ready;
        const deadline = Date.now() + 3000;
        do {
          const [row] = await prisma.$queryRaw`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
          if (row.blocked) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        assert.equal(blocked, true, "Concurrent writer must be waiting on a database lock, not merely scheduled later");
      });
      try {
        assert.equal((await adopt(true, {}, client)).status, "adopted");
      } finally {
        if (writer) assert.equal(await writer, null, "Writer completes after adoption releases its locks");
      }
      assert.equal(blocked, true);
      assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).supportOwnerUserId, admin.id);
      assert.equal(await prisma.auditLog.count({ where: { workspaceId: workspace.id, action: ADOPTION_ACTION } }), 1);
    });
  }

  it("serializes concurrent adoption and never duplicates the ownership audit", async () => {
    const results = await Promise.allSettled([adopt(), adopt()]);
    assert.ok(results.some(r => r.status === "fulfilled" && r.value.status === "adopted"));
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason.code === "P2034" || (r.reason.code === "P2010" && r.reason.meta?.code === "40001"), "Only a serialization conflict may lose the race");
      }
    }
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).supportOwnerUserId, admin.id);
    assert.equal(await prisma.auditLog.count({ where: { workspaceId: workspace.id, action: ADOPTION_ACTION } }), 1);
  });

  it("rechecks owner under lock when another transaction sets it first", async () => {
    const other = await newUser();
    let signal;
    const locked = new Promise(resolve => { signal = resolve; });
    let release;
    const proceed = new Promise(resolve => { release = resolve; });
    const writer = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspace.id} FOR UPDATE`;
      signal();
      await proceed;
      await tx.workspace.update({ where: { id: workspace.id }, data: { supportOwnerUserId: other.id } });
    });
    await locked;
    const attempt = adopt();
    const rejected = assert.rejects(attempt);
    release();
    await writer;
    await rejected;
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).supportOwnerUserId, other.id);
    assert.equal(await prisma.auditLog.count({ where: { workspaceId: workspace.id, action: ADOPTION_ACTION } }), 0);
  });
});
