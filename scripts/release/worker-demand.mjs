/** A boolean KEDA metric, not a claim query. Claimed work keeps its sole worker
 * alive; future retries become demand as time passes without another insert.
 * The independent scheduler job covers work that has not reached either queue.
 */
export const WORKER_DEMAND_QUERY = `SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM public."Event" e
    WHERE e.status = 'PENDING' AND (
      e."lockedAt" IS NOT NULL OR (
        e."availableAt" <= pg_catalog.now() AND NOT EXISTS (
          SELECT 1 FROM public."WorkspaceFeatureFlag" f
          WHERE f."workspaceId" = e."workspaceId"
            AND f.flag = 'operator_import_inactive' AND f.enabled = true
        )
      )
    )
  ) OR EXISTS (
    SELECT 1 FROM public."WorkflowJob" j
    LEFT JOIN public."WorkflowJob" dependency ON dependency.id = j."dependsOnJobId"
    WHERE j.status = 'RUNNING' OR (
      j.status = 'PENDING' AND j."runAfter" <= pg_catalog.now()
      AND (j."dependsOnJobId" IS NULL OR dependency.status = 'COMPLETED')
      AND NOT EXISTS (
        SELECT 1 FROM public."WorkspaceFeatureFlag" f
        WHERE f."workspaceId" = j."workspaceId"
          AND f.flag = 'operator_import_inactive' AND f.enabled = true
      )
    )
  ) THEN 1 ELSE 0 END AS demand`;

const TABLE_COLUMNS = Object.freeze({
  Event: ["status", "lockedAt", "availableAt", "workspaceId"],
  WorkflowJob: ["id", "status", "dependsOnJobId", "runAfter", "workspaceId"],
  WorkspaceFeatureFlag: ["workspaceId", "flag", "enabled"],
});
const quote = value => `"${value.replaceAll('"', '""')}"`;
class WorkerScalerRoleError extends Error {
  constructor(code) { super(code); this.name = "WorkerScalerRoleError"; }
}
const need = (value, code) => { if (!value) throw new WorkerScalerRoleError(code); };
export const workerScalerRoleDiagnostic = error => error instanceof WorkerScalerRoleError ? error.message : null;

/** Create-only role provisioning on one explicitly bound database. The caller
 * owns authenticated TLS, server identity, a serialized maintenance lease and
 * secure credential custody. No role alteration or secret rotation is implicit.
 * Existing application roles, PUBLIC grants and other databases are untouched.
 */
export async function provisionWorkerScalerRole({ client, database, role, password } = {}) {
  need(client && typeof client.query === "function"
    && typeof database === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(database)
    && typeof role === "string" && /^worker_scale_[a-z0-9_]{1,48}$/.test(role)
    && typeof password === "string" && /^[a-f0-9]{64}$/.test(password), "WORKER_SCALER_ROLE_INPUT_INVALID");
  let transaction = false;
  try {
    await client.query("BEGIN"); transaction = true;
    const identity = await client.query("SELECT current_database() AS database");
    need(identity.rows.length === 1 && identity.rows[0].database === database, "WORKER_SCALER_DATABASE_MISMATCH");
    const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
    need(existing.rows.length === 0, "WORKER_SCALER_ROLE_ALREADY_EXISTS");
    // Password is generated high-entropy hex; never include SQL or raw driver
    // diagnostics in the returned receipt/error.
    await client.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      await client.query(`GRANT SELECT (${columns.map(quote).join(", ")}) ON TABLE public.${quote(table)} TO ${quote(role)}`);
    }
    const access = await client.query(`SELECT
      pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND pg_catalog.has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS broad_access,
      pg_catalog.has_column_privilege($1, 'public."Event"', 'payload', 'SELECT') AS event_payload,
      pg_catalog.has_column_privilege($1, 'public."WorkflowJob"', 'payload', 'SELECT') AS job_payload`, [role]);
    need(access.rows.length === 1 && Object.values(access.rows[0]).every(value => value === false), "WORKER_SCALER_EXCESS_PRIVILEGES");
    await client.query(`SET LOCAL ROLE ${quote(role)}`);
    const result = await client.query(WORKER_DEMAND_QUERY);
    need(result.rows.length === 1 && [0, 1].includes(result.rows[0].demand), "WORKER_SCALER_PROJECTION_INVALID");
    await client.query("RESET ROLE");
    await client.query("COMMIT"); transaction = false;
    return { database, role, created: true, demand: result.rows[0].demand,
      access: "queue eligibility columns only; no payload or application write access", connectionLimit: 2 };
  } catch (error) {
    if (transaction) {
      try { await client.query("ROLLBACK"); }
      catch { throw new WorkerScalerRoleError("WORKER_SCALER_ROLE_ROLLBACK_UNCERTAIN"); }
    }
    throw error instanceof WorkerScalerRoleError ? error : new WorkerScalerRoleError("WORKER_SCALER_ROLE_PROVISION_FAILED");
  }
}

/** Bind the exact secret value before provisioning/activation. KEDA receives this
 * same DSN through its versioned Key Vault reference; alternate endpoints or TLS
 * overrides are deliberately unsupported. Return only non-secret identity data.
 */
export function validateWorkerScalerConnection({ connectionString, host, database, role } = {}) {
  need(typeof host === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.postgres\.database\.azure\.com$/.test(host)
    && typeof database === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(database)
    && typeof role === "string" && /^worker_scale_[a-z0-9_]{1,48}$/.test(role), "WORKER_SCALER_CONNECTION_BINDING_INVALID");
  let url;
  try { url = new URL(connectionString); } catch { throw new WorkerScalerRoleError("WORKER_SCALER_CONNECTION_INVALID"); }
  let user, db, secret;
  try { user = decodeURIComponent(url.username); db = decodeURIComponent(url.pathname.slice(1)); secret = decodeURIComponent(url.password); }
  catch { throw new WorkerScalerRoleError("WORKER_SCALER_CONNECTION_INVALID"); }
  need(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === host && (!url.port || url.port === "5432")
    && user === role && db === database && secret.length >= 32 && !url.hash
    && [...url.searchParams].length === 1 && url.searchParams.get("sslmode") === "verify-full",
  "WORKER_SCALER_CONNECTION_INVALID");
  return { host, database, role, port: 5432, tls: "verify-full" };
}

/** Read-only qualification of a freshly connected scaler credential. The caller
 * connects using the exact validated secret version, retains that version binding
 * in its private receipt, and owns connection cleanup. This helper cannot infer
 * credentials from a Key Vault URI and does not attest cloud scaler behavior.
 */
export async function verifyWorkerScalerAccess({ client, database, role } = {}) {
  need(client && typeof client.query === "function" && client.connection?.stream?.encrypted === true
    && client.connection.stream.authorized === true && typeof database === "string" && typeof role === "string",
  "WORKER_SCALER_VERIFIED_TLS_REQUIRED");
  try {
    const identity = await client.query(`SELECT current_database() AS database, current_user AS role,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
    const observed = identity.rows[0];
    need(identity.rows.length === 1 && observed.database === database && observed.role === role
      && ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "memberships"].every(k => observed[k] === false)
      && observed.rolconnlimit === 2, "WORKER_SCALER_ROLE_IDENTITY_INVALID");
    const access = await client.query(`SELECT
      pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS broad_access,
      pg_catalog.has_column_privilege(current_user, 'public."Event"', 'payload', 'SELECT') AS event_payload,
      pg_catalog.has_column_privilege(current_user, 'public."WorkflowJob"', 'payload', 'SELECT') AS job_payload`);
    need(access.rows.length === 1 && Object.values(access.rows[0]).every(value => value === false), "WORKER_SCALER_EXCESS_PRIVILEGES");
    const result = await client.query(WORKER_DEMAND_QUERY);
    need(result.rows.length === 1 && [0, 1].includes(result.rows[0].demand), "WORKER_SCALER_PROJECTION_INVALID");
    return { database, role, demand: result.rows[0].demand, verifiedTls: true, connectionLimit: 2,
      access: "queue eligibility columns only; no payload or application write access" };
  } catch (error) {
    throw error instanceof WorkerScalerRoleError ? error : new WorkerScalerRoleError("WORKER_SCALER_ACCESS_UNPROVEN");
  }
}
