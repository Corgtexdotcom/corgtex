import { createHash } from "node:crypto";
import { checkServerIdentity, TLSSocket } from "node:tls";
import pg from "pg";

type Row = Record<string, string | number | boolean | null>;
export type LeadDatabaseBinding = {
  host: string; port: number; database: string; user: string; workspaceId: string;
};
export type CoreLeadTransferBinding = {
  source: LeadDatabaseBinding; target: LeadDatabaseBinding; targetMemberIds: string[];
};
export type CoreLeadBundle = {
  version: 1; binding: CoreLeadTransferBinding;
  schema: Record<string, unknown[]>; leads: Row[]; deliveries: Row[]; sha256: string;
};
const tables = ["DemoLead", "NewspaperDelivery"] as const;
const receiptKey = "coreLeadTransfer";
const flags = ["operator_import_inactive", "crm_public_writes_paused"];
class LeadTransferError extends Error {}
function fail(code: string): never { throw new LeadTransferError(`CORE_LEAD_TRANSFER_${code}`); }
export function leadTransferHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
}

// Bind to a real connected TLS socket before any SQL. A matching database name
// or receipt on a clone is insufficient authority to write.
function boundClient(client: pg.Client, binding: LeadDatabaseBinding, same?: TLSSocket) {
  if (!(client instanceof pg.Client) || !binding || !binding.workspaceId
    || !binding.database || !binding.user || !binding.host || !Number.isInteger(binding.port)) fail("BINDING_REQUIRED");
  const live = client as pg.Client & {
    _connected: boolean; _ending: boolean; _ended: boolean;
    connection: { stream: TLSSocket & { _rejectUnauthorized?: boolean } };
  };
  const socket = live.connection?.stream;
  if (!live._connected || live._ending || live._ended || client.host !== binding.host || client.port !== binding.port
    || client.database !== binding.database || client.user !== binding.user) fail("TARGET_MISMATCH");
  if (!(socket instanceof TLSSocket) || socket.encrypted !== true || socket.authorized !== true
    || socket._rejectUnauthorized !== true || socket.destroyed || socket.remotePort !== binding.port
    || (same && same !== socket) || checkServerIdentity(binding.host, socket.getPeerCertificate())) fail("TLS_REQUIRED");
  return socket;
}
function validateBinding(binding: CoreLeadTransferBinding) {
  if (!binding || !Array.isArray(binding.targetMemberIds) || !binding.targetMemberIds.length
    || binding.targetMemberIds.some((id) => typeof id !== "string" || !id)
    || new Set(binding.targetMemberIds).size !== binding.targetMemberIds.length
    || binding.source?.workspaceId === binding.target?.workspaceId
    || binding.source?.host === binding.target?.host && binding.source?.port === binding.target?.port
      && binding.source?.database === binding.target?.database) fail("DISTINCT_BOUND_WORKSPACES_REQUIRED");
}
async function workspaceHold(client: pg.Client, binding: LeadDatabaseBinding, lock = false) {
  const identity = (await client.query("SELECT current_user AS user, current_database() AS database")).rows[0];
  if (identity.user !== binding.user || identity.database !== binding.database) fail("DATABASE_IDENTITY_MISMATCH");
  const workspace = (await client.query(`SELECT id, slug FROM public."Workspace" WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [binding.workspaceId])).rows;
  if (workspace.length !== 1 || workspace[0].slug !== "corgtex") fail("WORKSPACE_MISMATCH");
  const markers = (await client.query(`SELECT flag, enabled, config FROM public."WorkspaceFeatureFlag"
    WHERE "workspaceId"=$1 AND flag=ANY($2::text[])${lock ? " FOR UPDATE" : ""}`, [binding.workspaceId, flags])).rows;
  if (markers.length !== 2 || markers.some((marker) => marker.enabled !== true)) fail("WRITER_AND_CONSUMER_HOLD_REQUIRED");
  const claimed = (await client.query(`SELECT count(*)::int AS count FROM public."WorkflowJob"
    WHERE "workspaceId"=$1 AND (status='RUNNING' OR "lockedAt" IS NOT NULL OR "lockedBy" IS NOT NULL)`, [binding.workspaceId])).rows[0];
  if (claimed.count !== 0) fail("CLAIMED_WORK_REQUIRES_DRAIN");
  const claimedEvents = (await client.query(`SELECT count(*)::int AS count FROM public."Event"
    WHERE "workspaceId"=$1 AND ("lockedAt" IS NOT NULL OR "lockedBy" IS NOT NULL)`, [binding.workspaceId])).rows[0];
  if (claimedEvents.count !== 0) fail("CLAIMED_WORK_REQUIRES_DRAIN");
  return markers.find((marker) => marker.flag === "crm_public_writes_paused").config;
}
async function schema(client: pg.Client) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) result[table] = (await client.query(`SELECT column_name, udt_name, is_nullable, datetime_precision, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (Object.values(result).some((columns) => !columns.length)) fail("SCHEMA_REQUIRED");
  return result;
}
async function rows(client: pg.Client, table: typeof tables[number], workspaceId: string): Promise<Row[]> {
  const selected = (await client.query(`SELECT row_to_json(t)::text AS frame FROM public."${table}" t
    WHERE "workspaceId"=$1${table === "NewspaperDelivery" ? ' AND "demoLeadId" IS NOT NULL' : ""}
    ORDER BY id LIMIT 1001`, [workspaceId])).rows;
  if (selected.length > 1000) fail("BOUNDED_EXPORT_EXCEEDED");
  // Preserve PostgreSQL timestamp precision; pg's Date conversion loses it.
  return selected.map(({ frame }) => JSON.parse(frame));
}
async function sourceState(source: pg.Client, binding: CoreLeadTransferBinding) {
  await workspaceHold(source, binding.source);
  const leads = await rows(source, "DemoLead", binding.source.workspaceId);
  if (!leads.length || leads.some((lead) => lead.convertedContactId !== null)) fail("LEAD_REFERENCE_CLOSURE_CHANGED");
  for (const [table, column] of [["CrmQualification", "workspaceId"], ["CrmConversation", "workspaceId"],
    ["CrmProspectWorkspace", "crmWorkspaceId"]]) {
    const existing = (await source.query(`SELECT count(*)::int AS count FROM public."${table}"
      WHERE "${column}"=$1 AND "demoLeadId" IS NOT NULL`, [binding.source.workspaceId])).rows[0];
    if (existing.count !== 0) fail("LEAD_REFERENCE_CLOSURE_CHANGED");
  }
  const deliveries = await rows(source, "NewspaperDelivery", binding.source.workspaceId);
  const ids = new Set(leads.map((lead) => lead.id));
  if (deliveries.some((delivery) => delivery.memberId !== null || !ids.has(delivery.demoLeadId))) fail("DELIVERY_REFERENCE_REQUIRES_REVIEW");
  return { schema: await schema(source), leads, deliveries };
}
async function targetMembers(target: pg.Client, binding: CoreLeadTransferBinding) {
  const found = (await target.query(`SELECT id FROM public."Member" WHERE "workspaceId"=$1 ORDER BY id`,
    [binding.target.workspaceId])).rows.map(({ id }) => id);
  if (leadTransferHash(found) !== leadTransferHash([...binding.targetMemberIds].sort())) fail("TARGET_RECIPIENTS_CHANGED");
}
async function emptyTarget(target: pg.Client, workspaceId: string) {
  for (const [table, column] of [["DemoLead", "workspaceId"], ["CrmContact", "workspaceId"], ["CrmAccount", "workspaceId"],
    ["CrmQualification", "workspaceId"], ["CrmConversation", "workspaceId"], ["CrmProspectWorkspace", "crmWorkspaceId"]]) {
    const count = (await target.query(`SELECT count(*)::int AS count FROM public."${table}" WHERE "${column}"=$1`, [workspaceId])).rows[0].count;
    if (count !== 0) fail("TARGET_CRM_NOT_EMPTY");
  }
}
async function transactions<T>(source: pg.Client, target: pg.Client, binding: CoreLeadTransferBinding,
  write: boolean, operation: (sourceSocket: TLSSocket, targetSocket: TLSSocket) => Promise<T>): Promise<T> {
  validateBinding(binding);
  const sourceSocket = boundClient(source, binding.source), targetSocket = boundClient(target, binding.target);
  try {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query(write ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await source.query("SET LOCAL statement_timeout='15s'");
    await target.query("SET LOCAL statement_timeout='15s'");
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    await target.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await operation(sourceSocket, targetSocket);
    boundClient(source, binding.source, sourceSocket); boundClient(target, binding.target, targetSocket);
    await source.query("COMMIT");
    await target.query("COMMIT");
    return result;
  } catch (error) {
    await Promise.allSettled([source.query("ROLLBACK"), target.query("ROLLBACK")]);
    // PostgreSQL unique errors may contain an email or bearer token.
    if (error instanceof LeadTransferError) throw error;
    fail("TRANSACTION_FAILED");
  }
}

/** PRIVATE bundle: original lead tokens/data and delivery/job provenance. */
export async function prepareCoreLeadTransfer(source: pg.Client, target: pg.Client, binding: CoreLeadTransferBinding): Promise<CoreLeadBundle> {
  return transactions(source, target, binding, false, async () => {
    await workspaceHold(target, binding.target);
    await targetMembers(target, binding);
    await emptyTarget(target, binding.target.workspaceId);
    const state = await sourceState(source, binding);
    if (leadTransferHash(state.schema) !== leadTransferHash(await schema(target))) fail("SCHEMA_MISMATCH");
    const body = { version: 1 as const, binding: structuredClone(binding), ...state };
    return { ...body, sha256: leadTransferHash(body) };
  });
}

/** No source mutations, membership adoption, queue replay, activation or routing changes. */
export async function importCoreLeadTransfer(source: pg.Client, target: pg.Client, bundle: CoreLeadBundle,
  binding: CoreLeadTransferBinding, execute: true) {
  if (execute !== true) fail("EXECUTE_REQUIRED");
  const { sha256, ...body } = bundle;
  if (bundle.version !== 1 || sha256 !== leadTransferHash(body)
    || leadTransferHash(bundle.binding) !== leadTransferHash(binding)) fail("BUNDLE_BINDING_MISMATCH");
  return transactions(source, target, binding, true, async (sourceSocket, targetSocket) => {
    const config = await workspaceHold(target, binding.target, true);
    await targetMembers(target, binding);
    const current = await sourceState(source, binding);
    if (leadTransferHash(current) !== leadTransferHash({ schema: bundle.schema, leads: bundle.leads, deliveries: bundle.deliveries })) fail("SOURCE_CHANGED");
    if (leadTransferHash(bundle.schema) !== leadTransferHash(await schema(target))) fail("SCHEMA_MISMATCH");
    const receipt = { version: 1, sha256, sourceWorkspaceId: binding.source.workspaceId,
      targetWorkspaceId: binding.target.workspaceId, leads: bundle.leads.length, deliveries: bundle.deliveries.length };
    const prior = config?.[receiptKey];
    if (prior && leadTransferHash(prior) !== leadTransferHash(receipt)) fail("RECEIPT_CONFLICT");
    if (!prior) await emptyTarget(target, binding.target.workspaceId);
    for (const [table, sourceRows] of [["DemoLead", bundle.leads], ["NewspaperDelivery", bundle.deliveries]] as const) {
      for (const row of sourceRows) {
        const mapped = { ...row, workspaceId: binding.target.workspaceId,
          ...(table === "NewspaperDelivery" ? { workflowJobId: null } : {}) };
        if (!prior) {
          boundClient(source, binding.source, sourceSocket); boundClient(target, binding.target, targetSocket);
          // Explicit, schema-checked columns avoid defaulting/overwriting fields.
          const columns = Object.keys(mapped).map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
          await target.query(`INSERT INTO public."${table}" (${columns}) SELECT ${columns}
            FROM jsonb_populate_record(NULL::public."${table}", $1::jsonb)`, [JSON.stringify(mapped)]);
        }
        const found = (await target.query(`SELECT row_to_json(t)::text AS frame FROM public."${table}" t WHERE id=$1`, [row.id])).rows;
        if (found.length !== 1 || leadTransferHash(JSON.parse(found[0].frame)) !== leadTransferHash(mapped)) fail("IMPORTED_ROWS_CHANGED");
      }
      if ((await rows(target, table, binding.target.workspaceId)).length !== sourceRows.length) fail("IMPORTED_ROWS_CHANGED");
    }
    if (!prior) await target.query(`UPDATE public."WorkspaceFeatureFlag" SET config=$2::jsonb, "updatedAt"=clock_timestamp()
      WHERE "workspaceId"=$1 AND flag='crm_public_writes_paused' AND enabled=true`,
    [binding.target.workspaceId, JSON.stringify({ ...(config ?? {}), [receiptKey]: receipt })]);
    return { ...receipt, alreadyImported: Boolean(prior), writerAndConsumerHoldsRetained: true };
  });
}
