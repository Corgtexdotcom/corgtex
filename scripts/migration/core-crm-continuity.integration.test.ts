import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { checkServerIdentity, TLSSocket } from "node:tls";
import pg from "pg";
import { exportTenantSnapshot, hashCanonical, hashFrames } from "./shared-tenant-export";
import { importTenantSnapshot, type TenantImportOptions } from "./shared-tenant-import";
import { inventorySharedTenantSource, quoteIdentifier } from "./shared-tenant-inventory.mjs";
import { prepareCoreCrmContinuity, restoreCoreQualificationTokens } from "./core-crm-continuity";
import { transferScalarFieldKinds, type TenantTransferManifest, type TenantTransferSnapshot } from "./shared-tenant-transfer-contract";

function url(side: "source" | "target" | "clone") {
  const input = process.env[`CORE_CONTINUITY_${side.toUpperCase()}_URL`];
  if (!input) throw new Error("Explicit isolated synthetic database required");
  const value = new URL(input);
  if (!["localhost", "127.0.0.1"].includes(value.hostname) || value.pathname !== `/continuity_${side === "clone" ? "target" : side}_test`
    || value.search) throw new Error("Isolated continuity test database required");
  return input;
}
const ca = readFileSync(process.env.CORE_CONTINUITY_TLS_CA!);
const ssl = { ca, rejectUnauthorized: true };
const source = new pg.Client({ connectionString: url("source") });
const target = new pg.Client({ connectionString: url("target"), ssl });
const clone = new pg.Client({ connectionString: url("clone"), ssl });
const prismaUrl = new URL(url("target"));
prismaUrl.searchParams.set("sslmode", "require");
prismaUrl.searchParams.set("sslcert", process.env.CORE_CONTINUITY_TLS_CA!);
prismaUrl.searchParams.set("sslaccept", "strict");
assert.equal(process.env.DATABASE_URL, prismaUrl.href);
assert.equal(process.env.CORE_CONTINUITY_CONSUMER_HOLD_READY, "true");
const endpoint = (input: string) => { const value = new URL(input); return { host: value.hostname, port: Number(value.port || 5432) }; };
function stream(client: pg.Client) {
  return (client as pg.Client & { connection: { stream: TLSSocket } }).connection.stream;
}
async function spyQueries(client: pg.Client, intercept: (sql: string) => void, run: () => Promise<unknown>,
  afterQuery?: (sql: string, params?: unknown[]) => void) {
  const original = client.query;
  client.query = (async (sql: string, params?: unknown[]) => {
    intercept(sql);
    const result = await original.call(client, sql, params);
    afterQuery?.(sql, params);
    return result;
  }) as typeof client.query;
  try { await run(); } finally { client.query = original; }
}
const workspace = "synthetic-core-corgtex", other = "synthetic-existing-target", actor = "synthetic-core-actor";
const states = ["sent", "skipped", "pending"];
const insert = async (db: pg.Client, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  await db.query(`INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
};
const at = "2026-09-01T09:00:00.000Z";
async function seed() {
  await insert(source, "Workspace", { id: workspace, slug: "corgtex", name: "Synthetic internal Corgtex CRM", updatedAt: at });
  await insert(source, "User", { id: actor, email: "actor@example.invalid", passwordHash: "synthetic-source-password", globalRole: "OPERATOR", updatedAt: at });
  await insert(source, "Member", { id: "synthetic-core-member", workspaceId: workspace, userId: actor });
  await insert(source, "AgentIdentity", { id: "synthetic-core-agent", workspaceId: workspace, agentKey: "fixture", displayName: "Synthetic agent", updatedAt: at });
  await insert(source, "MeetingSeries", { id: "synthetic-core-series", workspaceId: workspace, title: "Synthetic recurrence", startsAt: at, recurrenceRule: "FREQ=WEEKLY", updatedAt: at });
  for (const state of states) {
    const lead = `lead-${state}`, account = `account-${state}`, contact = `contact-${state}`, deal = `deal-${state}`;
    await insert(source, "CrmAccount", { id: account, workspaceId: workspace, name: `Synthetic ${state}`, slug: state, ownerUserId: actor, updatedAt: at });
    await insert(source, "CrmContact", { id: contact, workspaceId: workspace, accountId: account, email: `${state}@example.invalid`, updatedAt: at });
    await insert(source, "DemoLead", { id: lead, workspaceId: workspace, email: `${state}@example.invalid`, qualifyToken: `synthetic-only-token-${state}`,
      convertedContactId: contact, welcomeEmailSentAt: state === "sent" ? at : null, createdAt: at, lastSeenAt: at });
    await insert(source, "CrmDeal", { id: deal, workspaceId: workspace, accountId: account, contactId: contact, title: `Synthetic ${state} deal`, stage: "QUALIFIED", ownerUserId: actor, updatedAt: at });
    await insert(source, "CrmDealStageTransition", { id: `transition-${state}`, workspaceId: workspace, dealId: deal, fromStage: "LEAD", toStage: "QUALIFIED", actorUserId: actor, createdAt: at });
    await insert(source, "CrmQualification", { id: `qualification-${state}`, workspaceId: workspace, demoLeadId: lead, responseChannel: "EMAIL", rawEmailReply: "Synthetic qualification history", status: "APPROVED", reviewedByUserId: actor, reviewedAt: at, updatedAt: at });
    await insert(source, "CrmConversation", { id: `conversation-${state}`, workspaceId: workspace, demoLeadId: lead, accountId: account, contactId: contact, dealId: deal, subject: "Synthetic lead conversation", updatedAt: at });
    await insert(source, "CrmConversationMessage", { id: `message-${state}`, conversationId: `conversation-${state}`, senderType: "ADMIN", senderUserId: actor, bodyMd: "Synthetic history remains attached", createdAt: at });
    await insert(source, "CrmActivity", { id: `activity-${state}`, workspaceId: workspace, accountId: account, contactId: contact, dealId: deal, actorUserId: actor, title: "Synthetic qualification note", bodyMd: "Historical context", createdAt: at });
  }
  await insert(source, "Event", { id: "event-history", workspaceId: workspace, type: "demo.lead.created", payload: JSON.stringify({ demoLeadId: "lead-sent" }), status: "DISPATCHED", dispatchedAt: at });
  await insert(source, "WorkflowJob", { id: "job-history", workspaceId: workspace, eventId: "event-history", type: "agent.demo-welcome-newspaper", payload: JSON.stringify({ demoLeadId: "lead-sent" }), status: "COMPLETED", completedAt: at, updatedAt: at });
  await insert(source, "NewspaperDelivery", { id: "delivery-sent", workspaceId: workspace, demoLeadId: "lead-sent", workflowJobId: "job-history", kind: "DEMO_WELCOME", runKey: "job-history", recipientEmail: "sent@example.invalid", subject: "Synthetic sent history (not a live send)", status: "SENT", providerMessageId: "synthetic-provider-receipt", sentAt: at });
  await insert(source, "Event", { id: "event-pending", workspaceId: workspace, type: "demo.lead.created", payload: '{"demoLeadId":"lead-pending","integer":9007199254740993}', status: "PENDING" });
  for (const [id, status, lockedBy] of [["job-pending", "PENDING", null], ["job-claimed", "RUNNING", "synthetic-source-worker"]]) {
    await insert(source, "WorkflowJob", { id, workspaceId: workspace, eventId: "event-pending", type: "agent.demo-welcome-newspaper",
      payload: '{"demoLeadId":"lead-pending","integer":9007199254740993,"fraction":0.1234567890123456789}', status, attempts: 2,
      lockedBy, lockedAt: lockedBy ? at : null, updatedAt: at });
  }
  await insert(target, "Workspace", { id: other, slug: other, name: "Existing target tenant", updatedAt: at });
  await insert(target, "User", { id: "target-actor", email: "existing@example.invalid", passwordHash: "existing-password-preserved", globalRole: "OPERATOR", updatedAt: at });
  await insert(target, "Member", { id: "target-member", workspaceId: other, userId: "target-actor" });
  await insert(target, "CrmAccount", { id: "target-account", workspaceId: other, name: "Existing account", slug: "existing", updatedAt: at });
  await insert(target, "CrmContact", { id: "target-contact", workspaceId: other, accountId: "target-account", email: "existing@example.invalid", updatedAt: at });
  await insert(target, "DemoLead", { id: "target-due-lead", workspaceId: other, email: "due@example.invalid", createdAt: at, lastSeenAt: at, followUpCount: 1 });
  console.log("PASS coherent source graph and separate existing target tenant seeded");
}

async function manifest(): Promise<TenantTransferManifest> {
  const inventory = await inventorySharedTenantSource(source);
  const tables: TenantTransferManifest["tables"] = {};
  for (const table of inventory.tables.filter((entry: { rows: string }) => BigInt(entry.rows) > 0n)) {
    const fields: NonNullable<TenantTransferManifest["tables"][string]["fields"]> = {};
    for (const column of inventory.schema.columns.filter((c: { table: string }) => c.table === table.name)) {
      if (/^jsonb?$/.test(column.type) || column.type.endsWith("[]")) fields[column.name] = { kind: "content", reason: "Synthetic fixture content retained exactly as PostgreSQL text" };
    }
    for (const [column, kind] of Object.entries(transferScalarFieldKinds[table.name] ?? {})) {
      fields[column] = { kind, reason: "Explicit synthetic fixture scalar classification" };
      if (kind === "reference" && /(?:UserId|actorUserId)$/.test(column)) fields[column].references = { table: "User", column: "id" };
    }
    if (table.name === "DemoLead") fields.convertedContactId.references = { table: "CrmContact", column: "id" };
    tables[table.name] = { disposition: table.name === "_prisma_migrations" ? "operator-control" : "copy", reason: "Bounded synthetic Core qualification", fields };
  }
  return { formatVersion: 1, transferId: "synthetic-core-lead-transfer", workspaceId: workspace, workspaceSlug: "corgtex", schemaSha256: inventory.schemaSha256, tables };
}
function options(snapshot: TenantTransferSnapshot, removeTokens = true): TenantImportOptions {
  const body = { formatVersion: 1 as const, transferId: snapshot.manifest.transferId, sourceSnapshotSha256: snapshot.sha256,
    sourceStoreId: "empty-source", targetStoreId: "empty-target", entries: [] };
  return { identityLinks: [], objectReceipt: { ...body, sha256: hashCanonical(body) },
    objectStorageBinding: { sourceStoreId: body.sourceStoreId, targetStoreId: body.targetStoreId },
    transforms: removeTokens ? { DemoLead: { qualifyToken: { kind: "null", reason: "Generic import never transfers qualification capability" } } } : {} };
}
before(async () => { await source.connect(); await target.connect(); await clone.connect(); await seed(); });
after(async () => { await source.end(); await target.end(); await clone.end(); const { prisma } = await import("../../packages/shared/src/db"); await prisma.$disconnect(); });

test("rejects a real export that excludes populated queues through operator-control", async () => {
  const policy = await manifest();
  // Exclude the referencing delivery too, so this is a valid export rather
  // than an exporter FK-closure rejection masquerading as an admission test.
  for (const name of ["Event", "WorkflowJob", "NewspaperDelivery"]) policy.tables[name].disposition = "operator-control";
  const omitted = await exportTenantSnapshot(source, policy);
  assert.equal(omitted.tables.some(table => ["Event", "WorkflowJob"].includes(table.name)), false);
  for (const name of ["Event", "WorkflowJob"]) {
    const disposition = omitted.dispositions.find(row => row.table === name)!;
    assert.ok(BigInt(disposition.sourceRows) > 0n);
    assert.equal(disposition.selectedRows, "0");
  }
  assert.throws(() => prepareCoreCrmContinuity(omitted), /QUEUE_COPY_REQUIRED/);
});

test("actual CRM export/publication/import and explicit qualification continuity", async (t) => {
  await source.query('UPDATE "WorkflowJob" SET "dependsOnJobId"=$1 WHERE id=$2', ["job-history", "job-pending"]);
  await insert(source, "WorkflowJob", { id: "job-blocked", workspaceId: workspace, dependsOnJobId: "job-claimed", type: "synthetic.blocked",
    payload: '{"integer":9007199254740993}', status: "PENDING", dedupeKey: "core-blocked", updatedAt: at });
  const snapshot = await exportTenantSnapshot(source, await manifest());
  const original = structuredClone(snapshot);
  const bundle = prepareCoreCrmContinuity(snapshot), publication = bundle.publication.publicationSnapshot;
  const oldTarget = (await target.query('SELECT row_to_json(w)::text AS row FROM "Workspace" w')).rows;
  const existingTenant = async () => {
    const rows: Record<string, unknown> = {};
    for (const [table, id] of [["User", "target-actor"], ["Member", "target-member"], ["CrmAccount", "target-account"], ["CrmContact", "target-contact"], ["DemoLead", "target-due-lead"]]) {
      rows[table] = (await target.query(`SELECT row_to_json(r)::text AS row FROM ${quoteIdentifier(table)} r WHERE id=$1`, [id])).rows;
    }
    return rows;
  };
  const existingBefore = await existingTenant();
  await assert.rejects(importTenantSnapshot(target, snapshot, options(snapshot)), /TRANSFER_SOURCE_WORK_NOT_DRAINED/);
  await assert.rejects(importTenantSnapshot(target, publication, options(publication, false)), /TRANSFER_QUALIFICATION_TOKEN_MUST_BE_REMOVED/);
  const imported = await importTenantSnapshot(target, publication, options(publication));
  const binding = { execute: true as const, target: { database: "continuity_target_test", user: "postgres", endpoint: endpoint(url("target")) }, expectedImportReceiptSha256: hashCanonical(imported.receipt) };
  const restore = () => restoreCoreQualificationTokens(target, bundle, binding);
  const readTokens = async () => (await target.query('SELECT id,"qualifyToken" FROM "DemoLead" WHERE "workspaceId"=$1 ORDER BY id', [workspace])).rows;
  const nullTokens = await readTokens();
  assert.ok(nullTokens.every(row => row.qualifyToken === null));
  const marker = async () => (await target.query('SELECT enabled,config FROM "WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag=$2', [workspace, "operator_import_inactive"])).rows[0];
  const initialMarker = await marker();
  async function rejectBeforeSql(client: pg.Client, expected: string, override = binding) {
    let queries = 0;
    await spyQueries(client, () => { queries++; }, async () =>
      assert.rejects(restoreCoreQualificationTokens(client, bundle, override), { message: `CORE_CONTINUITY_${expected}` }));
    assert.equal(queries, 0, "transport rejection must precede BEGIN and token UPDATE");
  }
  await t.test("a TLS clone with identical DB/user/import receipt at another endpoint rejects before SQL", async () => {
    await importTenantSnapshot(clone, publication, options(publication));
    await clone.query('UPDATE "WorkspaceFeatureFlag" SET config=$2::jsonb WHERE "workspaceId"=$1 AND flag=$3',
      [workspace, JSON.stringify(initialMarker.config), "operator_import_inactive"]);
    assert.deepEqual((await clone.query("SELECT current_database() AS database, current_user AS user")).rows,
      (await target.query("SELECT current_database() AS database, current_user AS user")).rows);
    const cloned = (await clone.query('SELECT config FROM "WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag=$2', [workspace, "operator_import_inactive"])).rows[0];
    assert.equal(hashCanonical(cloned.config.transferReceipt), binding.expectedImportReceiptSha256);
    assert.notDeepEqual(endpoint(url("clone")), binding.target.endpoint);
    for (const client of [target, clone]) {
      assert.equal(stream(client).authorized, true);
      for (const host of ["localhost", "127.0.0.1"]) assert.equal(checkServerIdentity(host, stream(client).getPeerCertificate()), undefined);
    }
    await rejectBeforeSql(clone, "ENDPOINT_MISMATCH");
    assert.equal((await clone.query('SELECT count(*) FROM "DemoLead" WHERE "qualifyToken" IS NOT NULL')).rows[0].count, "0");
  });
  await t.test("missing endpoint, wrong host/port, query wrappers and pools reject before SQL", async () => {
    await rejectBeforeSql(target, "ENDPOINT_REQUIRED", { ...binding, target: { ...binding.target, endpoint: undefined! } });
    for (const changed of [{ ...binding.target.endpoint, port: binding.target.endpoint.port + 1 }, { ...binding.target.endpoint, host: "elsewhere.invalid" }]) {
      await rejectBeforeSql(target, "ENDPOINT_MISMATCH", { ...binding, target: { ...binding.target, endpoint: changed } });
    }
    let calls = 0;
    const wrapper = { query: async () => { calls++; throw new Error("must not query"); } };
    await assert.rejects(restoreCoreQualificationTokens(wrapper as unknown as pg.Client, bundle, binding), /CLIENT_REQUIRED/);
    assert.equal(calls, 0);
    const pool = new pg.Pool({ connectionString: url("target"), ssl });
    try { await assert.rejects(restoreCoreQualificationTokens(pool as unknown as pg.Client, bundle, binding), /CLIENT_REQUIRED/); }
    finally { await pool.end(); }
    await rejectBeforeSql(new pg.Client({ connectionString: url("target"), ssl }), "CONNECTION_REQUIRED");
  });
  for (const [name, config, code, host] of [
    ["plaintext", { ssl: false }, "TLS_REQUIRED"],
    ["untrusted CA with rejection disabled", { ssl: { rejectUnauthorized: false } }, "TLS_REQUIRED"],
    ["trusted CA but rejection disabled", { ssl: { ca, rejectUnauthorized: false } }, "TLS_REQUIRED"],
    ["URL SSL override", { connectionString: url("target") + "?sslmode=no-verify", ssl }, "TLS_REQUIRED"],
    ["custom callback bypassing wrong hostname", { connectionString: undefined, host: "127.0.0.2", port: binding.target.endpoint.port,
      user: "postgres", password: new URL(url("target")).password, database: binding.target.database,
      ssl: { ...ssl, checkServerIdentity: () => undefined } }, "TLS_HOSTNAME_MISMATCH", "127.0.0.2"],
  ] as const) {
    await t.test(`rejects real connected ${name} before BEGIN`, async () => {
      const client = new pg.Client({ connectionString: url("target"), ...config });
      try {
        await client.connect();
        if (host) assert.equal(stream(client).authorized, true, "custom callback alone does not prove hostname");
        await rejectBeforeSql(client, code, host ? { ...binding, target: { ...binding.target, endpoint: { ...binding.target.endpoint, host } } } : binding);
      } finally { await client.end(); }
    });
  }
  await t.test("untrusted CA is rejected by the actual TLS handshake", async () => {
    const client = new pg.Client({ connectionString: url("target"), ssl: { rejectUnauthorized: true } });
    try { await assert.rejects(client.connect()); } finally { await client.end(); }
  });
  await t.test("revalidates the same live socket and remote port immediately before token writes", async () => {
    const replacement = new pg.Client({ connectionString: url("target"), ssl });
    await replacement.connect();
    const connection = (target as pg.Client & { connection: { stream: TLSSocket } }).connection;
    const original = connection.stream;
    const lastTable = imported.receipt.tables.filter(table => table.primaryKeys.length > 0).at(-1)!;
    let changed = false, writes = 0;
    try {
      await spyQueries(target, sql => {
        if (sql.startsWith('UPDATE public."DemoLead"')) writes++;
        if (sql === "ROLLBACK") connection.stream = original;
      }, async () => assert.rejects(restore(), /SOCKET_CHANGED/), (sql, params) => {
        if (sql.includes(`::text AS row FROM public."${lastTable.name}"`)
          && JSON.stringify(params) === JSON.stringify(lastTable.primaryKeys.at(-1))) {
          connection.stream = stream(replacement); changed = true;
        }
      });
    } finally { connection.stream = original; await target.query("ROLLBACK"); await replacement.end(); }
    assert.equal(changed, true); assert.equal(writes, 0);
    // Spoofed pg endpoint metadata must not mask a different TCP peer port.
    const client = target as pg.Client & { connectionParameters: { port: number } };
    const port = client.port;
    try {
      client.port = client.connectionParameters.port = port + 1;
      await rejectBeforeSql(client, "TLS_REQUIRED", { ...binding, target: { ...binding.target, endpoint: { ...binding.target.endpoint, port: port + 1 } } });
    } finally { client.port = client.connectionParameters.port = port; }
  });
  await t.test("CRM IDs, links and historical fields survive publication and import", async () => {
    for (const table of snapshot.tables.filter(entry => entry.name.startsWith("Crm"))) {
      for (const row of table.rows) {
        const found = await target.query(`SELECT json_build_array(${table.columns.map(column => `${quoteIdentifier(column.name)}::text`).join(",")})::text AS frame FROM ${quoteIdentifier(table.name)} WHERE id=$1`, [row[table.columns.findIndex(column => column.name === "id")]]);
        assert.deepEqual(JSON.parse(found.rows[0].frame), row);
      }
    }
  });
  await t.test("quarantine preserves full source precision/state and cannot be claimed from target", async () => {
    assert.deepEqual(snapshot, original);
    for (const staged of bundle.publication.staging.rows) {
      const table = original.tables.find(row => row.name === staged.table)!;
      for (const [index, [id]] of staged.primaryKeys.entries()) assert.deepEqual(staged.rows[index], table.rows.find(row => row[table.columns.findIndex(c => c.name === "id")] === id));
    }
    assert.ok(JSON.stringify(bundle.publication.staging).includes("9007199254740993"));
    assert.ok(JSON.stringify(bundle.publication.staging).includes("0.1234567890123456789"));
    const { runPendingJobs, dispatchPendingEvents } = await import("../../packages/workflows/src/outbox");
    assert.equal(await runPendingJobs("synthetic-no-replay"), 0);
    assert.equal(await dispatchPendingEvents("synthetic-no-replay"), 0);
    assert.equal((await target.query('SELECT count(*) FROM "WorkflowJob" WHERE "workspaceId"=$1', [workspace])).rows[0].count, "0");
    assert.equal((await target.query('SELECT "workflowJobId" FROM "NewspaperDelivery" WHERE id=$1', ["delivery-sent"])).rows[0].workflowJobId, null);
  });
  await t.test("wrong target, stale receipt, inactive-marker removal and changed lead state reject", async () => {
    await assert.rejects(restoreCoreQualificationTokens(target, bundle, { ...binding, target: { ...binding.target, database: "wrong" } }), /TARGET_MISMATCH/);
    await assert.rejects(restoreCoreQualificationTokens(target, bundle, { ...binding, expectedImportReceiptSha256: "a".repeat(64) }), /IMPORT_RECEIPT_MISMATCH/);
    await target.query('UPDATE "WorkspaceFeatureFlag" SET enabled=false WHERE "workspaceId"=$1', [workspace]);
    try { await assert.rejects(restore(), /INACTIVE_IMPORT_REQUIRED/); }
    finally { await target.query('UPDATE "WorkspaceFeatureFlag" SET enabled=true WHERE "workspaceId"=$1', [workspace]); }
    await target.query('UPDATE "DemoLead" SET "visitCount"=99 WHERE id=$1', ["lead-pending"]);
    try { await assert.rejects(restore(), /RESTORE_FAILED/); }
    finally { await target.query('UPDATE "DemoLead" SET "visitCount"=1 WHERE id=$1', ["lead-pending"]); }
  });
  await t.test("cross-workspace IDs, token collisions, partial retries and reintroduced queue rows reject", async () => {
    await target.query('UPDATE "DemoLead" SET "workspaceId"=$1 WHERE id=$2', [other, "lead-pending"]);
    try { await assert.rejects(restore(), /LEAD_STATE_MISMATCH/); }
    finally { await target.query('UPDATE "DemoLead" SET "workspaceId"=$1 WHERE id=$2', [workspace, "lead-pending"]); }
    await target.query('UPDATE "DemoLead" SET "qualifyToken"=$1 WHERE id=$2', ["synthetic-only-token-pending", "target-due-lead"]);
    try { await assert.rejects(restore(), /TOKEN_COLLISION/); }
    finally { await target.query('UPDATE "DemoLead" SET "qualifyToken"=NULL WHERE id=$1', ["target-due-lead"]); }
    await target.query('UPDATE "DemoLead" SET "qualifyToken"=$1 WHERE id=$2', ["synthetic-only-token-pending", "lead-pending"]);
    try { await assert.rejects(restore(), /LEAD_STATE_MISMATCH/); }
    finally { await target.query('UPDATE "DemoLead" SET "qualifyToken"=NULL WHERE id=$1', ["lead-pending"]); }
    await insert(target, "WorkflowJob", { id: "wrong-live-id", workspaceId: other, type: "synthetic", payload: "{}", dedupeKey: "core-blocked", updatedAt: at });
    try { await assert.rejects(restore(), /QUARANTINE_CONFLICT/); }
    finally { await target.query('DELETE FROM "WorkflowJob" WHERE id=$1', ["wrong-live-id"]); }
  });
  await t.test("failure after token write rolls back all tokens and receipt without leaking SQL details", async () => {
    let writes = 0;
    await spyQueries(target, sql => {
      if (sql.startsWith('UPDATE public."DemoLead"') && ++writes === 2) throw new Error("synthetic raw-token-detail must not escape");
    }, async () => assert.rejects(restore(), (error: Error) => error.message === "CORE_CONTINUITY_RESTORE_FAILED"));
    assert.equal(writes, 2); assert.deepEqual(await readTokens(), nullTokens); assert.deepEqual(await marker(), initialMarker);
    await spyQueries(target, sql => {
      if (sql === "COMMIT") throw new Error("synthetic failure before commit");
    }, async () => assert.rejects(restore(), /RESTORE_FAILED/));
    await spyQueries(target, sql => {
      if (sql.startsWith("BEGIN")) throw new Error("CORE_CONTINUITY_SYNTHETIC_SECRET");
    }, async () => assert.rejects(restore(), { message: "CORE_CONTINUITY_RESTORE_FAILED" }));
    assert.deepEqual(await readTokens(), nullTokens); assert.deepEqual(await marker(), initialMarker);
  });
  await t.test("restore only original qualification capabilities; verify exact idempotent retry", async () => {
    const first = await restore();
    assert.equal(first.alreadyRestored, false); assert.equal(first.held, true);
    assert.equal(JSON.stringify(first).includes("synthetic-only-token"), false);
    assert.deepEqual(await restore(), { ...first, alreadyRestored: true });
    assert.equal(first.receipt.targetSha256, hashCanonical(binding.target));
    assert.deepEqual(await restoreCoreQualificationTokens(target, bundle, { ...binding, target: { ...binding.target,
      endpoint: { ...binding.target.endpoint, host: binding.target.endpoint.host.toUpperCase() + "." } } }),
    { ...first, alreadyRestored: true });
    assert.equal((await marker()).enabled, true);
    assert.deepEqual((await marker()).config.transferReceipt, initialMarker.config.transferReceipt);
    assert.deepEqual((await target.query('SELECT "passwordHash","globalRole" FROM "User" WHERE id=$1', [actor])).rows[0],
      { passwordHash: "disabled:operator-import:synthetic-core-lead-transfer", globalRole: "USER" });
    assert.equal((await target.query('SELECT count(*) FROM "Member" WHERE "workspaceId"=$1 AND "isActive"', [workspace])).rows[0].count, "0");
    await target.query('UPDATE "DemoLead" SET "qualifyToken"=NULL WHERE id=$1', ["lead-pending"]);
    try { await assert.rejects(restore(), /LEAD_STATE_MISMATCH/); }
    finally { await target.query('UPDATE "DemoLead" SET "qualifyToken"=$1 WHERE id=$2', ["synthetic-only-token-pending", "lead-pending"]); }
    const restoredConfig = (await marker()).config;
    const legacy = structuredClone(restoredConfig);
    const { sha256: _legacyDigest, ...legacyBody } = legacy.coreQualificationContinuity;
    legacyBody.targetSha256 = hashCanonical({ database: binding.target.database, user: binding.target.user });
    legacy.coreQualificationContinuity = { ...legacyBody, sha256: hashCanonical(legacyBody) };
    await target.query('UPDATE "WorkspaceFeatureFlag" SET config=$2::jsonb WHERE "workspaceId"=$1', [workspace, JSON.stringify(legacy)]);
    try { await assert.rejects(restore(), /RESTORE_RECEIPT_MISMATCH/); }
    finally { await target.query('UPDATE "WorkspaceFeatureFlag" SET config=$2::jsonb WHERE "workspaceId"=$1', [workspace, JSON.stringify(restoredConfig)]); }
    await target.query('UPDATE "DemoLead" SET "visitCount"=99 WHERE id=$1', ["lead-pending"]);
    const leadTable = publication.tables.find(table => table.name === "DemoLead")!;
    const frames = [];
    for (const row of leadTable.rows) {
      const found = await target.query(`SELECT json_build_array(${leadTable.columns.map(column => `${quoteIdentifier(column.name)}::text`).join(",")})::text AS frame FROM "DemoLead" WHERE id=$1`, [row[leadTable.columns.findIndex(column => column.name === "id")]]);
      frames.push(JSON.parse(found.rows[0].frame));
    }
    const forgedConfig = structuredClone(restoredConfig);
    const { sha256: _digest, ...forgedBody } = forgedConfig.coreQualificationContinuity;
    forgedBody.leadRowsSha256 = hashFrames(frames);
    forgedConfig.coreQualificationContinuity = { ...forgedBody, sha256: hashCanonical(forgedBody) };
    await target.query('UPDATE "WorkspaceFeatureFlag" SET config=$2::jsonb WHERE "workspaceId"=$1', [workspace, JSON.stringify(forgedConfig)]);
    try { await assert.rejects(restore(), /LEAD_STATE_MISMATCH/); }
    finally {
      await target.query('UPDATE "DemoLead" SET "visitCount"=1 WHERE id=$1', ["lead-pending"]);
      await target.query('UPDATE "WorkspaceFeatureFlag" SET config=$2::jsonb WHERE "workspaceId"=$1', [workspace, JSON.stringify(restoredConfig)]);
    }
  });
  await t.test("old link retains real submission semantics, including repeated submissions; invalid token rejects", async () => {
    const { submitQualification } = await import("../../packages/domain/src/crm");
    const form = { token: "synthetic-only-token-pending", companyName: " Synthetic ", website: "https://example.invalid", aiExperience: "none", helpNeeded: "planning" };
    const first = await submitQualification(form), second = await submitQualification(form);
    assert.notEqual(first.id, second.id);
    assert.equal(first.workspaceId, workspace); assert.equal(first.demoLeadId, "lead-pending");
    assert.equal(first.companyName, "Synthetic"); assert.equal(first.status, "PENDING_REVIEW"); assert.equal(first.responseChannel, "form");
    await assert.rejects(submitQualification({ ...form, token: "invalid" }), /Invalid qualification token/);
    assert.equal((await target.query('SELECT count(*) FROM "CrmQualification" WHERE "workspaceId"=$1', [other])).rows[0].count, "0");
    assert.equal((await target.query('SELECT count(*) FROM "Event" WHERE "workspaceId"=$1 AND status=\'PENDING\'', [workspace])).rows[0].count, "2");
    assert.equal((await restore()).alreadyRestored, true);
  });
  await t.test("new intake events remain unclaimed after consumer-hold integration", async () => {
    const { runPendingJobs, dispatchPendingEvents } = await import("../../packages/workflows/src/outbox");
    assert.equal(await dispatchPendingEvents("synthetic-held"), 0);
    assert.equal(await runPendingJobs("synthetic-held"), 0);
  });
  assert.deepEqual((await target.query('SELECT row_to_json(w)::text AS row FROM "Workspace" w WHERE id=$1', [other])).rows, oldTarget);
  assert.deepEqual(await existingTenant(), existingBefore);
  assert.deepEqual((await exportTenantSnapshot(source, await manifest())).tables, snapshot.tables);
});

test("real zero-row queue selection remains valid without attributing global or other-tenant work to Core", async () => {
  // This is the last fixture case; only these owned synthetic source rows change.
  await source.query('DELETE FROM "WorkflowJob"');
  await source.query('DELETE FROM "Event"');
  async function selectedEmpty() {
    const policy = await manifest();
    for (const name of ["Event", "WorkflowJob"]) policy.tables[name] ??= { disposition: "copy", reason: "Explicit empty queue selection" };
    return exportTenantSnapshot(source, policy);
  }
  const empty = await selectedEmpty();
  assert.equal(empty.dispositions.some(row => ["Event", "WorkflowJob"].includes(row.table)), false);
  assert.deepEqual(prepareCoreCrmContinuity(empty).publication.staging.rows, []);
  await insert(source, "Workspace", { id: "source-other", slug: "source-other", name: "Other source tenant", updatedAt: at });
  await insert(source, "Event", { id: "global-pending", workspaceId: null, type: "synthetic", payload: "{}", status: "PENDING" });
  await insert(source, "WorkflowJob", { id: "other-pending", workspaceId: "source-other", type: "synthetic", payload: "{}", status: "PENDING", updatedAt: at });
  const foreignOnly = await selectedEmpty();
  for (const name of ["Event", "WorkflowJob"]) {
    const evidence = foreignOnly.dispositions.find(row => row.table === name)!;
    assert.equal(evidence.sourceRows, "1"); assert.equal(evidence.selectedRows, "0"); assert.equal(evidence.disposition, "copy");
  }
  assert.deepEqual(prepareCoreCrmContinuity(foreignOnly).publication.staging.rows, []);
});
