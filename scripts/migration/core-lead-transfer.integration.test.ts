import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { X509Certificate, createHash } from "node:crypto";
import { importCoreLeadTransfer, prepareCoreLeadTransfer, leadTlsOptions, verifyLeadCertificate, type CoreLeadTransferBinding } from "./core-lead-transfer";

function url(side: string) {
  const input = process.env[`CORE_LEAD_${side.toUpperCase()}_URL`];
  if (!input) throw new Error("Explicit isolated lead transfer database required");
  const value = new URL(input);
  if (value.hostname !== "127.0.0.1" || value.pathname !== `/lead_transfer_${side}_test` || value.search) {
    throw new Error("Isolated lead transfer database required");
  }
  return input;
}
const ssl = { ca: readFileSync(process.env.CORE_CONTINUITY_TLS_CA!), rejectUnauthorized: true };
const source = new pg.Client({ connectionString: url("source"), ssl });
const target = new pg.Client({ connectionString: url("target"), ssl });
const sourceId = "synthetic-lead-source", targetId = "synthetic-lead-target";
const binding: CoreLeadTransferBinding = {
  source: { host: "127.0.0.1", port: Number(new URL(url("source")).port), database: "lead_transfer_source_test", user: "postgres", workspaceId: sourceId },
  target: { host: "127.0.0.1", port: Number(new URL(url("target")).port), database: "lead_transfer_target_test", user: "postgres", workspaceId: targetId },
  targetMemberIds: ["synthetic-lead-recipient"],
};
before(async () => {
  await Promise.all([source.connect(), target.connect()]);
  for (const [db, id] of [[source, sourceId], [target, targetId]] as const) {
    assert.equal((await db.query('SELECT count(*) FROM "Workspace"')).rows[0].count, "0");
    await db.query('ALTER TABLE "DemoLead" ALTER COLUMN "createdAt" TYPE timestamp(6), ALTER COLUMN "lastSeenAt" TYPE timestamp(6), ALTER COLUMN "welcomeEmailSentAt" TYPE timestamp(6)');
    await db.query('ALTER TABLE "NewspaperDelivery" ALTER COLUMN "sentAt" TYPE timestamp(6)');
    await db.query('INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ($1,\'corgtex\',\'Synthetic CRM\',now())', [id]);
    for (const flag of ["operator_import_inactive", "crm_public_writes_paused"]) {
      await db.query('INSERT INTO "WorkspaceFeatureFlag" (id,"workspaceId",flag,enabled,"updatedAt") VALUES ($1,$2,$3,true,now())', [`${id}-${flag}`, id, flag]);
    }
  }
  await target.query('INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES (\'synthetic-lead-user\',\'lead-recipient@example.invalid\',\'synthetic-only\',now())');
  await target.query('INSERT INTO "Member" (id,"workspaceId","userId") VALUES ($1,$2,\'synthetic-lead-user\')', [binding.targetMemberIds[0], targetId]);
  await source.query(`INSERT INTO "DemoLead" (id,"workspaceId",email,"qualifyToken","createdAt","lastSeenAt","visitCount","followUpCount","welcomeEmailSentAt")
    VALUES ('synthetic-legacy-lead',$1,'legacy@example.invalid','synthetic-original-link',
    '2026-06-16 01:03:35.937123','2026-06-16 01:03:35.937456',9,2,'2026-06-16 01:03:35.937789')`, [sourceId]);
  await source.query(`INSERT INTO "WorkflowJob" (id,"workspaceId",type,payload,status,"updatedAt")
    VALUES ('synthetic-retained-job',$1,'synthetic.history','{}','COMPLETED',now())`, [sourceId]);
  await source.query(`INSERT INTO "NewspaperDelivery" (id,"workspaceId","workflowJobId","demoLeadId",kind,"runKey","recipientEmail",subject,status,"providerMessageId","sentAt")
    VALUES ('synthetic-legacy-delivery',$1,'synthetic-retained-job','synthetic-legacy-lead','DEMO_WELCOME','synthetic-run',
    'legacy@example.invalid','Synthetic original welcome','SENT','synthetic-provider-receipt','2026-06-16 01:03:35.937321')`, [sourceId]);
});
after(async () => { await Promise.allSettled([source.end(), target.end()]); });

test("source certificate alias requires its exact trusted root, name and leaf while target aliases fail", async () => {
  const certificate = (source as pg.Client & { connection: { stream: import("node:tls").TLSSocket } }).connection.stream.getPeerCertificate();
  const ca = readFileSync(process.env.CORE_CONTINUITY_TLS_CA!);
  const identity = { name: "localhost" as const, leafSha256: createHash("sha256").update(certificate.raw).digest("hex"),
    caSha256: createHash("sha256").update(new X509Certificate(ca).raw).digest("hex") };
  const pinned = { ...binding, source: { ...binding.source, certificateIdentity: identity } };
  assert.equal(verifyLeadCertificate(pinned.source, certificate), undefined);
  assert.ok(verifyLeadCertificate({ ...pinned.source, certificateIdentity: { ...identity, leafSha256: "0".repeat(64) } }, certificate));
  assert.ok(verifyLeadCertificate({ ...pinned.source, certificateIdentity: { ...identity, name: "wrong.invalid" as "localhost" } }, certificate));
  assert.throws(() => leadTlsOptions(pinned.source), /SOURCE_CA_PIN_MISMATCH/);
  assert.throws(() => leadTlsOptions({ ...pinned.source, certificateIdentity: { ...identity, caSha256: "0".repeat(64) } }, ca), /SOURCE_CA_PIN_MISMATCH/);
  assert.ok(verifyLeadCertificate({ ...binding.target, host: "wrong.invalid" }, certificate));
  const wrongPin = new pg.Client({ connectionString: url("source"), ssl: leadTlsOptions({ ...pinned.source,
    certificateIdentity: { ...identity, leafSha256: "0".repeat(64) } }, ca) });
  try { await assert.rejects(wrongPin.connect(), /CERTIFICATE_PIN_MISMATCH/); }
  finally { await wrongPin.end().catch(() => {}); }
  const aliasClient = new pg.Client({ connectionString: url("source"), ssl: leadTlsOptions(pinned.source, ca) });
  try {
    await aliasClient.connect();
    assert.equal((await prepareCoreLeadTransfer(aliasClient, target, pinned)).leads.length, 1);
    await assert.rejects(prepareCoreLeadTransfer(aliasClient, target, { ...pinned, source: { ...pinned.source, port: pinned.source.port + 1 } }), /TARGET_MISMATCH/);
    await assert.rejects(prepareCoreLeadTransfer(aliasClient, target, { ...pinned, target: { ...binding.target, certificateIdentity: identity } }), /TARGET_CERTIFICATE_ALIAS_FORBIDDEN/);
  } finally { await aliasClient.end(); }
});

test("bounded lead transfer preserves tokens, precise history and delivery provenance without replay", async (t) => {
  const bundle = await prepareCoreLeadTransfer(source, target, binding);
  assert.equal(bundle.leads[0].createdAt, "2026-06-16T01:03:35.937123");
  assert.equal(bundle.deliveries[0].workflowJobId, "synthetic-retained-job");
  const run = () => importCoreLeadTransfer(source, target, bundle, binding, true);
  await t.test("requires the explicit binding, writer/consumer hold and reviewed recipients", async () => {
    await assert.rejects(importCoreLeadTransfer(source, target, bundle, { ...binding, target: { ...binding.target, port: binding.target.port + 1 } }, true), /BUNDLE_BINDING_MISMATCH/);
    await target.query('UPDATE "WorkspaceFeatureFlag" SET enabled=false WHERE flag=\'crm_public_writes_paused\'');
    await assert.rejects(run(), /WRITER_AND_CONSUMER_HOLD_REQUIRED/);
    await target.query('UPDATE "WorkspaceFeatureFlag" SET enabled=true WHERE flag=\'crm_public_writes_paused\'');
    await target.query('UPDATE "Member" SET id=\'synthetic-changed-recipient\'');
    await assert.rejects(run(), /TARGET_RECIPIENTS_CHANGED/);
    await target.query('UPDATE "Member" SET id=\'synthetic-lead-recipient\'');
    await source.query(`INSERT INTO "Event" (id,"workspaceId",type,"aggregateType","aggregateId",payload,"lockedAt","lockedBy")
      VALUES ('synthetic-claimed-event',$1,'synthetic.held','Synthetic','synthetic','{}',now(),'synthetic-worker')`, [sourceId]);
    await assert.rejects(run(), /CLAIMED_WORK_REQUIRES_DRAIN/);
    await source.query('DELETE FROM "Event" WHERE id=\'synthetic-claimed-event\'');
  });
  await t.test("refuses changed live source and newly created qualification closure", async () => {
    await source.query('UPDATE "DemoLead" SET "visitCount"=10');
    await assert.rejects(run(), /SOURCE_CHANGED/);
    await source.query('UPDATE "DemoLead" SET "visitCount"=9');
    await source.query(`INSERT INTO "CrmQualification" (id,"workspaceId","demoLeadId","responseChannel","updatedAt")
      VALUES ('synthetic-late-qualification',$1,'synthetic-legacy-lead','form',now())`, [sourceId]);
    await assert.rejects(run(), /LEAD_REFERENCE_CLOSURE_CHANGED/);
    await source.query('DELETE FROM "CrmQualification" WHERE id=\'synthetic-late-qualification\'');
  });
  await t.test("failure after lead insertion rolls back all data and receipt", async () => {
    const original = target.query;
    target.query = (async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT INTO public."NewspaperDelivery"')) throw new Error("synthetic-original-link");
      return original.call(target, sql, values);
    }) as typeof target.query;
    try { await assert.rejects(run(), { message: "CORE_LEAD_TRANSFER_TRANSACTION_FAILED" }); }
    finally { target.query = original; }
    assert.equal((await target.query('SELECT count(*) FROM "DemoLead"')).rows[0].count, "0");
    assert.equal((await target.query('SELECT config FROM "WorkspaceFeatureFlag" WHERE flag=\'crm_public_writes_paused\'')).rows[0].config, null);
  });
  const receipt = await run();
  assert.equal(receipt.alreadyImported, false);
  assert.equal((await run()).alreadyImported, true);
  const lead = (await target.query('SELECT row_to_json(t)::text AS frame FROM "DemoLead" t')).rows[0];
  assert.deepEqual(JSON.parse(lead.frame), { ...bundle.leads[0], workspaceId: targetId });
  const delivery = JSON.parse((await target.query('SELECT row_to_json(t)::text AS frame FROM "NewspaperDelivery" t')).rows[0].frame);
  assert.deepEqual(delivery, { ...bundle.deliveries[0], workspaceId: targetId, workflowJobId: null });
  for (const table of ["Event", "WorkflowJob", "AgentCredential", "McpOAuthAccessToken"]) {
    assert.equal((await target.query(`SELECT count(*) FROM "${table}"`)).rows[0].count, "0");
  }
  await t.test("a retry with changed imported rows aborts without overwrite", async () => {
    await target.query('UPDATE "DemoLead" SET "visitCount"=11');
    await assert.rejects(run(), /IMPORTED_ROWS_CHANGED/);
    assert.equal((await target.query('SELECT "visitCount" FROM "DemoLead"')).rows[0].visitCount, 11);
    await target.query('UPDATE "DemoLead" SET "visitCount"=9');
  });
  await t.test("the old link submits in the target workspace only after the public writer hold is lifted", async (acceptance) => {
    const prismaUrl = new URL(url("target"));
    prismaUrl.searchParams.set("sslmode", "require");
    prismaUrl.searchParams.set("sslcert", process.env.CORE_CONTINUITY_TLS_CA!);
    prismaUrl.searchParams.set("sslaccept", "strict");
    process.env.DATABASE_URL = prismaUrl.href;
    process.env.APP_URL = "http://example.invalid";
    const { recordInboundEmailReply, submitQualification } = await import("../../packages/domain/src/crm");
    const { prisma } = await import("../../packages/shared/src/db");
    const form = { token: "synthetic-original-link", companyName: "Synthetic", website: "example.invalid", aiExperience: "none", helpNeeded: "planning" };
    try {
      await assert.rejects(submitQualification(form), (error: { code?: string }) => error.code === "CRM_PUBLIC_WRITES_PAUSED");
      assert.equal((await target.query('SELECT count(*) FROM "Event"')).rows[0].count, "0");
      await target.query('UPDATE "WorkspaceFeatureFlag" SET enabled=false WHERE flag=\'crm_public_writes_paused\'');
      const qualification = await submitQualification(form);
      assert.equal(qualification.workspaceId, targetId);
      assert.equal(qualification.demoLeadId, "synthetic-legacy-lead");
      const event = (await target.query('SELECT "workspaceId",type,status FROM "Event"')).rows[0];
      assert.deepEqual(event, { workspaceId: targetId, type: "crm.qualification.submitted", status: "PENDING" });
      const { dispatchPendingEvents, runPendingJobs } = await import("../../packages/workflows/src/outbox");
      assert.equal(await dispatchPendingEvents("synthetic-retirement-held"), 0);
      assert.equal(await runPendingJobs("synthetic-retirement-held"), 0);
      assert.equal((await source.query('SELECT count(*) FROM "CrmQualification"')).rows[0].count, "0");
      await acceptance.test("inbound qualification and conversation roll back together before a retry", async () => {
        await target.query(`INSERT INTO "CrmConversation" (id,"workspaceId","demoLeadId",subject,"updatedAt")
          VALUES ('synthetic-inbound-thread',$1,'synthetic-legacy-lead','Synthetic',now())`, [targetId]);
        await target.query(`CREATE FUNCTION public.synthetic_lead_reply_fail() RETURNS trigger LANGUAGE plpgsql AS
          $$BEGIN RAISE EXCEPTION 'synthetic-private-reply'; END$$`);
        await target.query('CREATE TRIGGER synthetic_lead_reply_fail BEFORE INSERT ON "CrmConversationMessage" FOR EACH ROW EXECUTE FUNCTION public.synthetic_lead_reply_fail()');
        const reply = { fromEmail: "legacy@example.invalid", subject: "Synthetic", bodyText: "Synthetic reply", providerEmailId: "synthetic-received-email" };
        try { await assert.rejects(recordInboundEmailReply(reply)); }
        finally {
          await target.query('DROP TRIGGER synthetic_lead_reply_fail ON "CrmConversationMessage"');
          await target.query('DROP FUNCTION public.synthetic_lead_reply_fail()');
        }
        assert.equal((await target.query('SELECT count(*) FROM "CrmQualification"')).rows[0].count, "1");
        assert.equal((await target.query('SELECT count(*) FROM "CrmConversationMessage"')).rows[0].count, "0");
        assert.equal((await target.query('SELECT count(*) FROM "Event"')).rows[0].count, "1");
        assert.equal((await target.query('SELECT count(*) FROM "InboundWebhook"')).rows[0].count, "0");
        await target.query(`INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('synthetic-other-crm','synthetic-other-crm','Other',now())`);
        await target.query(`INSERT INTO "DemoLead" (id,"workspaceId",email,"createdAt","lastSeenAt")
          VALUES ('synthetic-other-lead','synthetic-other-crm','legacy@example.invalid',now()+interval '1 day',now())`);
        await Promise.all([recordInboundEmailReply(reply), recordInboundEmailReply(reply)]);
        await recordInboundEmailReply(reply);
        assert.equal((await target.query('SELECT count(*) FROM "InboundWebhook"')).rows[0].count, "1");
        assert.equal((await target.query('SELECT "workspaceId" FROM "InboundWebhook"')).rows[0].workspaceId, targetId);
        assert.equal((await target.query('SELECT count(*) FROM "CrmQualification" WHERE "workspaceId"=\'synthetic-other-crm\'')).rows[0].count, "0");
        assert.equal((await target.query('SELECT count(*) FROM "CrmQualification"')).rows[0].count, "2");
        assert.equal((await target.query('SELECT count(*) FROM "CrmConversationMessage"')).rows[0].count, "1");
        assert.equal(await dispatchPendingEvents("synthetic-retirement-held"), 0);
      });
    } finally { await prisma.$disconnect(); }
  });
});
