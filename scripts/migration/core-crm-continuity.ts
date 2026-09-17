import { isIP } from "node:net";
import { checkServerIdentity, TLSSocket } from "node:tls";
import pg from "pg";
import { hashCanonical, hashFrames } from "./shared-tenant-export";
import { verifyImportedTenant } from "./shared-tenant-import";
import { quoteIdentifier, readSharedTenantSchema } from "./shared-tenant-inventory.mjs";
import { prepareTenantPublication, type PublicationRowSelection } from "./shared-tenant-publication";
import type { TenantTransferSnapshot, TransferTableData } from "./shared-tenant-transfer-contract";

const rule = "core-crm-continuity-v1" as const;
const inactiveFlag = "operator_import_inactive";
const receiptKey = "coreQualificationContinuity";
type Frame = (string | null)[];
export interface CoreCrmContinuityBundle {
  rule: typeof rule;
  sourceSnapshot: TenantTransferSnapshot;
  publication: ReturnType<typeof prepareTenantPublication>;
  sha256: string;
}
export interface CoreQualificationRestoreBinding {
  execute: true;
  // Approved independently of the connected client, never discovered from it.
  target: { database: string; user: string; endpoint: { host: string; port: number } };
  expectedImportReceiptSha256: string;
}
class CoreContinuityError extends Error {}
function fail(code: string): never { throw new CoreContinuityError(`CORE_CONTINUITY_${code}`); }
function normalizeHost(host: unknown): string {
  if (typeof host !== "string" || !host || host !== host.trim()) fail("ENDPOINT_REQUIRED");
  if (isIP(host) === 6) return new URL(`https://[${host}]`).hostname.slice(1, -1);
  if (isIP(host)) return host;
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (normalized.length > 253 || !normalized.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail("ENDPOINT_REQUIRED");
  return normalized;
}
function approvedTarget(binding: CoreQualificationRestoreBinding) {
  const target = binding.target;
  if (!target.endpoint || !Number.isInteger(target.endpoint.port)
    || target.endpoint.port < 1 || target.endpoint.port > 65535) fail("ENDPOINT_REQUIRED");
  return { database: target.database, user: target.user,
    endpoint: { host: normalizeHost(target.endpoint.host), port: target.endpoint.port } };
}
// pg 8 exposes the effective connection and Node 22 records certificate rejection
// on its TLSSocket. Inspect both, not the caller's pre-URL SSL configuration.
function boundSocket(client: pg.Client, target: ReturnType<typeof approvedTarget>, same?: TLSSocket): TLSSocket {
  try {
    if (!(client instanceof pg.Client)) fail("CLIENT_REQUIRED");
    const live = client as pg.Client & {
      _connected: boolean; _ending: boolean; _ended: boolean; _queryable: boolean;
      connectionParameters: { host: string; port: number };
      connection: { stream: TLSSocket & { _rejectUnauthorized?: boolean }; ssl: boolean | { rejectUnauthorized?: boolean } };
    };
    if (!live._connected || live._ending || live._ended || !live._queryable) fail("CONNECTION_REQUIRED");
    if (normalizeHost(live.host) !== target.endpoint.host || live.port !== target.endpoint.port
      || normalizeHost(live.connectionParameters.host) !== target.endpoint.host
      || live.connectionParameters.port !== target.endpoint.port) fail("ENDPOINT_MISMATCH");
    const socket = live.connection.stream;
    if (!(socket instanceof TLSSocket) || socket.encrypted !== true || socket.authorized !== true
      || socket._rejectUnauthorized !== true || !live.connection.ssl
      || (typeof live.connection.ssl === "object" && live.connection.ssl.rejectUnauthorized === false)
      || socket.destroyed || !socket.readable || !socket.writable || socket.connecting
      || socket.remotePort !== target.endpoint.port) fail("TLS_REQUIRED");
    if (same && socket !== same) fail("SOCKET_CHANGED");
    if (checkServerIdentity(target.endpoint.host, socket.getPeerCertificate())) fail("TLS_HOSTNAME_MISMATCH");
    return socket;
  } catch (error) {
    if (error instanceof CoreContinuityError) throw error;
    fail("TLS_REQUIRED");
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function value(table: TransferTableData, row: Frame, column: string) {
  const index = table.columns.findIndex((entry) => entry.name === column);
  if (index < 0) fail("COLUMN_REQUIRED");
  return row[index];
}
function identified(table: TransferTableData) {
  if (hashCanonical(table.primaryKey) !== hashCanonical(["id"])) fail("PRIMARY_KEY_UNSUPPORTED");
  return new Map(table.rows.map((row) => {
    const id = value(table, row, "id");
    if (!id) fail("ID_REQUIRED");
    return [id, row];
  }));
}
function leads(snapshot: TenantTransferSnapshot) {
  const table = snapshot.tables.find((entry) => entry.name === "DemoLead");
  if (!table) fail("LEADS_REQUIRED");
  const tokens = new Set<string>();
  const entries = [...identified(table)].map(([id, row]) => {
    if (value(table, row, "workspaceId") !== snapshot.manifest.workspaceId) fail("LEAD_WORKSPACE_MISMATCH");
    const token = value(table, row, "qualifyToken");
    if (token !== null) {
      if (!token.trim() || tokens.has(token)) fail("TOKEN_BINDING_INVALID");
      tokens.add(token);
    }
    return { id, token };
  });
  if (!entries.length) fail("LEADS_REQUIRED");
  return { table, entries };
}

/** PRIVATE artifact: includes original secrets and untouched PostgreSQL text frames.
 * No source mutation, filesystem storage, queue insertion or execution occurs here.
 */
export function prepareCoreCrmContinuity(sourceSnapshot: TenantTransferSnapshot): CoreCrmContinuityBundle {
  // Reuse publication validation before inspecting or deriving selections.
  prepareTenantPublication(sourceSnapshot, { stagedRows: [], detachReferences: [] });
  if (sourceSnapshot.manifest.workspaceSlug !== "corgtex" || sourceSnapshot.manifest.preparedFromSha256
    || sourceSnapshot.manifest.stagingSha256) fail("FRESH_CORE_SNAPSHOT_REQUIRED");
  const workspace = sourceSnapshot.tables.find((table) => table.name === "Workspace");
  if (!workspace || workspace.rows.length !== 1
    || value(workspace, workspace.rows[0], "id") !== sourceSnapshot.manifest.workspaceId
    || value(workspace, workspace.rows[0], "slug") !== "corgtex") fail("WORKSPACE_MISMATCH");
  leads(sourceSnapshot);
  for (const name of ["Event", "WorkflowJob"]) {
    const policy = sourceSnapshot.manifest.tables[name];
    if (policy?.disposition !== "copy" || typeof policy.reason !== "string" || !policy.reason.trim()) fail("QUEUE_COPY_REQUIRED");
    const table = sourceSnapshot.tables.find((entry) => entry.name === name);
    const evidence = sourceSnapshot.dispositions.filter((entry) => entry.table === name);
    // Export omits globally empty tables from BOTH arrays. A populated table
    // always has a disposition, even when workspace selection returns no rows.
    // sourceRows is database-wide, never a claim of ownership of global work.
    if (evidence.length === 0 && table === undefined) continue;
    const counts = evidence[0];
    if (evidence.length !== 1 || counts.disposition !== "copy" || counts.reason !== policy.reason
      || typeof counts.sourceRows !== "string" || typeof counts.selectedRows !== "string"
      || !/^[1-9]\d*$/.test(counts.sourceRows) || !/^(0|[1-9]\d*)$/.test(counts.selectedRows)
      || BigInt(counts.selectedRows) !== BigInt(table?.rows.length ?? 0)
      || BigInt(counts.sourceRows) < BigInt(counts.selectedRows)) fail("QUEUE_SELECTION_EVIDENCE_INVALID");
  }
  const queues = sourceSnapshot.tables.filter((table) => ["Event", "WorkflowJob"].includes(table.name));
  const indexes = new Map(queues.map((table) => [table.name, identified(table)]));
  const staged = new Map(queues.map((table) => [table.name, new Set<string>()]));
  for (const table of queues) for (const [id, row] of indexes.get(table.name)!) {
    if (value(table, row, "workspaceId") !== sourceSnapshot.manifest.workspaceId) fail("QUEUE_WORKSPACE_MISMATCH");
    const status = value(table, row, "status");
    const allowed = table.name === "Event" ? ["PENDING", "DISPATCHED", "FAILED"] : ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"];
    if (!status || !allowed.includes(status)) fail("QUEUE_STATUS_UNSUPPORTED");
    if (["PENDING", "RUNNING"].includes(status) || value(table, row, "lockedAt") !== null || value(table, row, "lockedBy") !== null) staged.get(table.name)!.add(id);
  }
  const jobs = queues.find((table) => table.name === "WorkflowJob");
  // Preserve the connected queue dependency graph, including terminal parents
  // and siblings. No blocked/leased row becomes terminal or loses its lease.
  let changed = true;
  while (changed && jobs) {
    changed = false;
    for (const [id, row] of indexes.get("WorkflowJob")!) {
      for (const [column, target] of [["eventId", "Event"], ["dependsOnJobId", "WorkflowJob"]]) {
        const reference = value(jobs, row, column);
        if (reference === null) continue;
        if (!indexes.get(target)?.has(reference)) fail("QUEUE_REFERENCE_MISSING");
        if (staged.get("WorkflowJob")!.has(id) || staged.get(target)!.has(reference)) {
          for (const [table, key] of [["WorkflowJob", id], [target, reference]]) {
            if (!staged.get(table)!.has(key)) { staged.get(table)!.add(key); changed = true; }
          }
        }
      }
    }
  }
  const reason = "Core unresolved work and dependency closure retained privately without replay";
  const stagedRows: PublicationRowSelection[] = queues.filter((table) => staged.get(table.name)!.size).map((table) => ({
    table: table.name, primaryKeys: [...staged.get(table.name)!].sort().map((id) => [id]), reason,
  }));
  const detachReferences: (PublicationRowSelection & { column: string })[] = [];
  for (const table of sourceSnapshot.tables.filter((entry) => !queues.includes(entry))) {
    for (const fk of table.foreignKeys.filter((entry) => staged.get(entry.referencedTable)?.size)) {
      if (fk.columns.length !== 1 || hashCanonical(fk.referencedColumns) !== hashCanonical(["id"])) fail("REFERENCE_SHAPE_UNSUPPORTED");
      const column = fk.columns[0];
      const affected = table.rows.filter((row) => staged.get(fk.referencedTable)!.has(value(table, row, column) ?? ""));
      if (!affected.length) continue;
      if (!table.columns.find((entry) => entry.name === column)?.nullable || column === "workspaceId" || table.primaryKey.includes(column)) fail("REQUIRED_REFERENCE_TO_QUARANTINE");
      detachReferences.push({ table: table.name, column, primaryKeys: affected.map((row) => table.primaryKey.map((name) => value(table, row, name))), reason });
    }
  }
  const publication = prepareTenantPublication(sourceSnapshot, { stagedRows, detachReferences });
  const body = { rule, sourceSnapshot: structuredClone(sourceSnapshot), publication };
  return { ...body, sha256: hashCanonical(body) };
}

export function verifyCoreCrmContinuity(bundle: CoreCrmContinuityBundle) {
  if (!bundle || bundle.rule !== rule || hashCanonical(prepareCoreCrmContinuity(bundle.sourceSnapshot)) !== hashCanonical(bundle)) fail("BUNDLE_MISMATCH");
  return bundle;
}

/** Purpose-scoped capability restoration ONLY. Caller owns source fencing,
 * private custody and routing authority. This never activates or replays work.
 * The held result reports the marker, not deployment of the consumer-hold code.
 * TLS binds the approved network endpoint, not an immutable physical cluster.
 * Do not expose this API as an unauthenticated application route.
 */
export async function restoreCoreQualificationTokens(client: pg.Client, bundle: CoreCrmContinuityBundle, binding: CoreQualificationRestoreBinding) {
  try { verifyCoreCrmContinuity(bundle); } catch { fail("BUNDLE_INVALID"); }
  if (binding?.execute !== true || typeof binding.target?.database !== "string" || !binding.target.database
    || typeof binding.target.user !== "string" || !binding.target.user
    || !/^[a-f0-9]{64}$/.test(binding.expectedImportReceiptSha256)) fail("EXPLICIT_BINDING_REQUIRED");
  const approved = approvedTarget(binding);
  const socket = boundSocket(client, approved);
  const snapshot = bundle.publication.publicationSnapshot;
  const { table, entries } = leads(snapshot);
  const workspaceId = snapshot.manifest.workspaceId;
  const tokenBindingsSha256 = hashCanonical(entries);
  const identity = { bundleSha256: bundle.sha256, importReceiptSha256: binding.expectedImportReceiptSha256,
    targetSha256: hashCanonical(approved), tokenBindingsSha256 };
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("SET LOCAL extra_float_digits = 3");
    await client.query("SET LOCAL bytea_output = 'hex'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const target = (await client.query("SELECT current_database() AS database, current_user AS user")).rows[0];
    if (!target || target.database !== approved.database || target.user !== approved.user) fail("TARGET_MISMATCH");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`tenant-transfer:${workspaceId}`]);
    const found = (await client.query('SELECT id, slug FROM public."Workspace" WHERE id=$1 OR slug=$2 FOR UPDATE', [workspaceId, "corgtex"])).rows;
    if (found.length !== 1 || found[0].id !== workspaceId || found[0].slug !== "corgtex") fail("WORKSPACE_MISMATCH");
    const markers = (await client.query('SELECT enabled, config FROM public."WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag=$2 FOR UPDATE', [workspaceId, inactiveFlag])).rows;
    const marker = markers[0];
    if (markers.length !== 1 || marker.enabled !== true || !record(marker.config)) fail("INACTIVE_IMPORT_REQUIRED");
    const config = marker.config, receipt = config.transferReceipt;
    if (!record(receipt) || hashCanonical(receipt) !== binding.expectedImportReceiptSha256
      || receipt.phase !== "INACTIVE" || receipt.transferId !== snapshot.manifest.transferId
      || receipt.workspaceId !== workspaceId || receipt.sourceSnapshotSha256 !== snapshot.sha256
      || receipt.manifestSha256 !== snapshot.manifestSha256 || receipt.schemaSha256 !== snapshot.schemaSha256) fail("IMPORT_RECEIPT_MISMATCH");
    if ((await readSharedTenantSchema(client)).schemaSha256 !== receipt.targetSchemaSha256) fail("TARGET_SCHEMA_MISMATCH");
    const leadReceipts = Array.isArray(receipt.tables) ? receipt.tables.filter((entry) => record(entry) && entry.name === "DemoLead") : [];
    const leadReceipt = leadReceipts[0];
    if (leadReceipts.length !== 1 || !record(leadReceipt) || !Array.isArray(leadReceipt.primaryKeys)) fail("IMPORT_RECEIPT_MISMATCH");
    const orderedIds = leadReceipt.primaryKeys.map((keys) => {
      if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== "string") fail("IMPORT_RECEIPT_MISMATCH");
      return keys[0];
    });
    if (hashCanonical([...orderedIds].sort()) !== hashCanonical(entries.map((entry) => entry.id).sort())) fail("IMPORT_RECEIPT_MISMATCH");
    const readLeadFrames = async () => {
      const frames: Frame[] = [];
      for (const id of orderedIds) {
        const found = await client.query(`SELECT json_build_array(${table.columns.map((column) => `${quoteIdentifier(column.name)}::text`).join(",")})::text AS frame FROM public."DemoLead" WHERE id=$1 AND "workspaceId"=$2`, [id, workspaceId]);
        if (found.rows.length !== 1 || typeof found.rows[0].frame !== "string") fail("LEAD_STATE_MISMATCH");
        const frame: unknown = JSON.parse(found.rows[0].frame);
        if (!Array.isArray(frame) || frame.length !== table.columns.length || frame.some((field) => field !== null && typeof field !== "string")) fail("LEAD_STATE_MISMATCH");
        frames.push(frame);
      }
      return frames;
    };
    for (const staged of bundle.publication.staging.rows) {
      const ids = staged.primaryKeys.map(([id]) => id);
      const conflict = await client.query(`SELECT id FROM public."${staged.table}" WHERE id=ANY($1::text[])`, [ids]);
      if (conflict.rows.length) fail("QUARANTINE_CONFLICT");
      if (staged.table === "WorkflowJob") {
        const position = staged.columns.findIndex((column) => column.name === "dedupeKey");
        if (position < 0) fail("COLUMN_REQUIRED");
        const keys = staged.rows.flatMap((row) => row[position] === null ? [] : [row[position]]);
        if ((await client.query('SELECT id FROM public."WorkflowJob" WHERE "dedupeKey"=ANY($1::text[])', [keys])).rows.length) fail("QUARANTINE_CONFLICT");
      }
    }
    const prior = config[receiptKey];
    if (prior !== undefined && (!record(prior) || prior.rule !== rule
      || Object.entries(identity).some(([key, expected]) => prior[key] !== expected))) fail("RESTORE_RECEIPT_MISMATCH");
    if (record(prior)) {
      const { sha256, ...body } = prior;
      if (sha256 !== hashCanonical(body)) fail("RESTORE_RECEIPT_MISMATCH");
    }
    const targetLeads = (await client.query('SELECT id, "workspaceId", "qualifyToken" FROM public."DemoLead" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [entries.map((entry) => entry.id)])).rows;
    if (targetLeads.length !== entries.length) fail("LEAD_SET_MISMATCH");
    for (const entry of entries) {
      const row = targetLeads.find((candidate) => candidate.id === entry.id);
      if (!row || row.workspaceId !== workspaceId || row.qualifyToken !== (prior === undefined ? null : entry.token)) fail("LEAD_STATE_MISMATCH");
    }
    const collisions = (await client.query('SELECT id FROM public."DemoLead" WHERE "qualifyToken"=ANY($1::text[]) AND NOT (id=ANY($2::text[]))',
      [entries.flatMap((entry) => entry.token === null ? [] : [entry.token]), entries.map((entry) => entry.id)])).rows;
    if (collisions.length) fail("TOKEN_COLLISION");
    const verification = structuredClone(receipt);
    if (record(prior)) {
      const frames = await readLeadFrames();
      const normalized = structuredClone(frames);
      const tokenIndex = table.columns.findIndex((column) => column.name === "qualifyToken");
      for (const frame of normalized) frame[tokenIndex] = null;
      if (hashFrames(normalized) !== leadReceipt.sha256) fail("LEAD_STATE_MISMATCH");
      const body = { rule, ...identity, leadRowsSha256: hashFrames(frames) };
      if (hashCanonical(prior) !== hashCanonical({ ...body, sha256: hashCanonical(body) })) fail("RESTORE_RECEIPT_MISMATCH");
      if (!Array.isArray(verification.tables)) fail("IMPORT_RECEIPT_MISMATCH");
      const verifiedLeadReceipt = verification.tables.find((entry) => record(entry) && entry.name === "DemoLead");
      if (!record(verifiedLeadReceipt) || typeof prior.leadRowsSha256 !== "string") fail("RESTORE_RECEIPT_MISMATCH");
      verifiedLeadReceipt.sha256 = prior.leadRowsSha256;
    }
    await verifyImportedTenant(client, snapshot, verification);
    boundSocket(client, approved, socket);
    if (prior !== undefined) { await client.query("COMMIT"); return { alreadyRestored: true, held: true, receipt: prior }; }
    for (const entry of entries.filter((entry) => entry.token !== null)) {
      boundSocket(client, approved, socket);
      const updated = await client.query('UPDATE public."DemoLead" SET "qualifyToken"=$1 WHERE id=$2 AND "workspaceId"=$3 AND "qualifyToken" IS NULL RETURNING id', [entry.token, entry.id, workspaceId]);
      if (updated.rows.length !== 1) fail("LEAD_STATE_MISMATCH");
    }
    // Hash post-restore frames in the same order as the original import receipt.
    const frames = await readLeadFrames();
    const body = { rule, ...identity, leadRowsSha256: hashFrames(frames) };
    const restoreReceipt = { ...body, sha256: hashCanonical(body) };
    const persisted = await client.query('UPDATE public."WorkspaceFeatureFlag" SET config=$3::jsonb, "updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND flag=$2 AND enabled=true RETURNING id',
      [workspaceId, inactiveFlag, JSON.stringify({ ...config, [receiptKey]: restoreReceipt })]);
    if (persisted.rows.length !== 1) fail("INACTIVE_IMPORT_REQUIRED");
    await client.query("COMMIT");
    return { alreadyRestored: false, held: true, receipt: restoreReceipt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // PostgreSQL uniqueness errors can contain the raw bearer token in detail.
    if (error instanceof CoreContinuityError) throw error;
    fail("RESTORE_FAILED");
  }
}
