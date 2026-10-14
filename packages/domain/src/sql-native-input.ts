import { createHash, randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import type { Prisma, SqlNativeRunInput } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { getRegisteredSqlNativeAccessValidator, getRegisteredSqlNativeDriver } from "./sql-native-driver";
import { renderSqlNativeRow } from "./sql-native-rendering";
import { assertOutsideArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { assertSqlIngestionAttemptCurrent, lockSqlIngestionAttempt, sqlIngestionConfigurationFingerprint,
  sqlIngestionOriginalPermissions, sqlIngestionSourceForCapture } from "./sql-ingestion-attempt";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  mergePermissionEpochProofs, parsePermissionEpochProof } from "./source-permission-epochs";
import { canReadSqlSource } from "./sql-source-policy";
import type { AuthenticatedSqlRunReceipt, SqlIngestionAttempt, SqlNativeDriverResult, SqlNativeDefinition, SqlNativeRow } from "./sql-ingestion-contract";

type Db = Prisma.TransactionClient | typeof prisma;
type Payload = Pick<SqlNativeDriverResult, "rows" | "pages" | "rowsProcessed" | "nextCursor"> & {renderingVersion: 1};
type Capture = {attempt: SqlIngestionAttempt; input: SqlNativeRunInput; payload: Payload;
  native: SqlNativeDriverResult; disposed: boolean; finalized: boolean};
const captures = new WeakMap<AuthenticatedSqlRunReceipt, Capture>();
// Cache only authenticated immutable bytes/shape, never access or permissions.
// Every lookup below still checks current source, caller, epochs and attempt;
// every ordinary delivery still invokes the registered native access validator.
const decoded = new Map<string, {encrypted: string; hash: string; configuration: string;
  rowsProcessed: number; nextCursor: string | null; payload: Payload; bytes: number}>();
let decodedBytes = 0;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function captureOf(attempt: SqlIngestionAttempt, receipt: AuthenticatedSqlRunReceipt) {
  const capture = captures.get(receipt);
  invariant(capture && capture.attempt === attempt && !capture.disposed,
    409, "SQL_NATIVE_RECEIPT_INVALID", "SQL receipt has no exact authenticated native capture.");
  return capture;
}

function validateNativeSet(payload: Payload, selectedTables: readonly string[]) {
  invariant(Array.isArray(payload.rows) && Array.isArray(payload.pages) && payload.rows.length <= 10_000
    && payload.renderingVersion === 1
    && payload.pages.length > 0 && payload.pages.length <= 10 && payload.rowsProcessed === payload.rows.length
    && (payload.nextCursor === null || typeof payload.nextCursor === "string" && payload.nextCursor.length <= 1_000_000),
  409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL run lacks complete bounded page evidence.");
  let offset = 0;
  const identities = new Set<string>();
  for (const page of payload.pages) {
    validateDefinition(page.definition);
    invariant(selectedTables.includes(page.table) && Number.isInteger(page.rowCount) && page.rowCount >= 0 && page.rowCount <= 1000,
      409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL page is outside its configured source.");
    const rows: readonly SqlNativeRow[] = payload.rows.slice(offset, offset + page.rowCount);
    invariant(rows.length === page.rowCount && (page.rowCount === 0 ? page.tail === null : isDeepStrictEqual(page.tail, rows.at(-1)!.values)),
      409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL page tail is incomplete.");
    for (const row of rows) {
      const key = JSON.stringify([row.table, row.primaryKey]);
      invariant(row.table === page.table && isDeepStrictEqual(row.definition, page.definition)
        && row.definition.key.length === 1 && typeof row.primaryKey === "string" && row.primaryKey.length > 0
        && Array.isArray(row.values) && row.values.length > 0 && row.values.every((value: unknown) => typeof value === "string")
        && row.row && typeof row.row === "object" && !Array.isArray(row.row)
        && !containsDecodedDate(row.row)
        // JavaScript enumerates integer-like keys numerically, independently of
        // SELECT order. Native column order is sealed by the trusted driver;
        // the raw record must contain that exact complete key set.
        && isDeepStrictEqual(Object.keys(row.row).sort(), row.definition.columns.map(column => column.name).sort())
        && row.values.length === (row.definition.cursor.name === row.definition.key[0].name ? 1 : 2)
        && row.content === renderSqlNativeRow(row.row, row.definition.columns)
        && !identities.has(key), 409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL row identity, definition or rendering is invalid.");
      identities.add(key);
    }
    offset += page.rowCount;
  }
  invariant(offset === payload.rows.length, 409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL run omitted page coverage.");
}

function containsDecodedDate(value: unknown, seen = new Set<object>()): boolean {
  if (value instanceof Date) return true;
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => containsDecodedDate(item, seen));
}

function validateDefinition(definition: SqlNativeDefinition) {
  const columns = definition?.columns;
  invariant(definition && typeof definition.schema === "string" && definition.schema.length > 0
    && typeof definition.name === "string" && definition.name.length > 0
    && Number.isInteger(definition.relationOid) && definition.relationOid > 0
    && Array.isArray(columns) && columns.length > 0 && columns.length <= 1600
    && columns.every((column, index) => column && typeof column.name === "string" && column.name.length > 0
      && typeof column.type === "string" && column.type.length > 0 && Number.isInteger(column.typeOid) && column.typeOid > 0
      && Number.isInteger(column.typeModifier) && Number.isInteger(column.collationOid) && column.collationOid >= 0
      && Number.isInteger(column.position) && column.position > (index ? columns[index - 1].position : 0)
      && typeof column.isNullable === "boolean" && ["", "a", "d"].includes(column.identity)
      && ["", "s", "v"].includes(column.generated))
    && new Set(columns.map(column => column.name)).size === columns.length
    && Array.isArray(definition.key) && definition.key.length === 1,
  409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL definition lacks its full authenticated column shape.");
  for (const selected of [definition.cursor, ...definition.key]) {
    const captured = columns.find(column => column.name === selected?.name);
    invariant(captured && ["type", "typeOid", "typeModifier", "collationOid"].every(field =>
      captured[field as keyof typeof captured] === selected[field as keyof typeof selected]),
    409, "SQL_NATIVE_RECEIPT_INVALID", "Native cursor/key metadata differs from its full captured column shape.");
  }
}

function originalPayload(input: SqlNativeRunInput, selectedTables: readonly string[]): Payload {
  const saved = decoded.get(input.id);
  if (saved && saved.encrypted === input.encryptedPayload && saved.hash === input.payloadHash
    && saved.configuration === input.configurationFingerprint && saved.rowsProcessed === input.rowsProcessed
    && saved.nextCursor === input.nextCursor) {
    decoded.delete(input.id); decoded.set(input.id, saved); return saved.payload;
  }
  const bytes = Buffer.from(decryptSecret(input.encryptedPayload), "base64");
  invariant(hash(bytes) === input.payloadHash, 409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL bytes changed.");
  const payload = deserialize(bytes) as Payload;
  validateNativeSet(payload, selectedTables);
  invariant(payload.rowsProcessed === input.rowsProcessed && payload.nextCursor === input.nextCursor,
    409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL header differs from its original bytes.");
  if (saved) {decoded.delete(input.id); decodedBytes -= saved.bytes;}
  if (bytes.length <= MAX_DECODED_BYTES) {
    while (decoded.size && (decoded.size >= 16 || decodedBytes + bytes.length > MAX_DECODED_BYTES)) {
      const id = decoded.keys().next().value!; decodedBytes -= decoded.get(id)!.bytes; decoded.delete(id);
    }
    decoded.set(input.id, {encrypted: input.encryptedPayload, hash: input.payloadHash, configuration: input.configurationFingerprint,
      rowsProcessed: input.rowsProcessed, nextCursor: input.nextCursor, payload: freeze(payload), bytes: bytes.length});
    decodedBytes += bytes.length;
  }
  return payload;
}

/** Only a registered authenticated connector is invoked. The application caller
 * supplies an opaque current attempt, never arbitrary rows or a replacement hook. */
export async function captureSqlIngestionAttempt(attempt: SqlIngestionAttempt): Promise<AuthenticatedSqlRunReceipt> {
  const source = await sqlIngestionSourceForCapture(attempt);
  // A transport-only registration cannot advance a checkpoint while its native
  // parents have no authenticated current-access reader.
  getRegisteredSqlNativeAccessValidator(source.driverType);
  const native = await getRegisteredSqlNativeDriver(source.driverType)({source, attempt,
    assertCurrentSource: () => assertSqlIngestionAttemptCurrent(attempt)});
  try {
    await assertSqlIngestionAttemptCurrent(attempt);
    // structuredClone turns Node Buffer cells into Uint8Array, changing their
    // native rendering and bytes representation. V8 retains PG native values.
    const fetched = deserialize(serialize({rows: native.rows, pages: native.pages,
      rowsProcessed: native.rowsProcessed, nextCursor: native.nextCursor, renderingVersion: 1})) as Payload;
    // A supplied text label cannot authenticate source content. Render the
    // preserved actual native cells using their complete sealed column order.
    invariant(Array.isArray(fetched.rows), 409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL rows are unavailable.");
    const payload: Payload = {...fetched, rows: fetched.rows.map((row: SqlNativeRow) => {
      validateDefinition(row.definition);
      invariant(row.row && typeof row.row === "object" && !Array.isArray(row.row),
        409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL row cells are unavailable.");
      invariant(!containsDecodedDate(row.row), 409, "SQL_NATIVE_RECEIPT_INVALID",
        "PostgreSQL temporal cells require their exact scoped native wire text.");
      return {...row, content: renderSqlNativeRow(row.row, row.definition.columns)};
    })};
    validateNativeSet(payload, source.selectedTables);
    // V8 preserves native Date, bigint and byte values independently of model
    // rendering. This binary payload is encrypted before durable storage.
    const bytes = serialize(payload);
    invariant(bytes.length <= 64 * 1024 * 1024, 413, "SQL_NATIVE_RUN_TOO_LARGE", "Native SQL run exceeds the bounded payload size.");
    const id = randomUUID(), original = sqlIngestionOriginalPermissions(attempt);
    const input = await prisma.$transaction(async tx => {
      await lockSqlIngestionAttempt(attempt, tx);
      const own = await capturePermissionEpochs(tx, attempt.workspaceId,
        artifactPermissionEpochIdentities("SqlNativeRunInput", {id, workspaceId: attempt.workspaceId, sourceId: attempt.sourceId}));
      return tx.sqlNativeRunInput.create({data: {id, workspaceId: attempt.workspaceId, sourceId: attempt.sourceId,
        attemptId: attempt.attemptId, generation: BigInt(attempt.generation), configurationFingerprint: attempt.configurationFingerprint,
        sourcePermissionEpoch: BigInt(original.entries.find(entry => entry.kind === "ExternalDataSource" && entry.id === attempt.sourceId)!.epoch),
        permissionEpochsJson: mergePermissionEpochProofs(original, own)!, encryptedPayload: encryptSecret(bytes.toString("base64")),
        payloadHash: hash(bytes), rowsProcessed: payload.rowsProcessed, nextCursor: payload.nextCursor}});
    }, {timeout: 10_000});
    const receipt = Object.freeze({receiptId: id}) as AuthenticatedSqlRunReceipt;
    captures.set(receipt, {attempt, input, payload: freeze(payload), native, disposed: false, finalized: false});
    return receipt;
  } catch (error) {await native.dispose().catch(() => undefined); throw error;}
}

/** Dedicated Knowledge preparation reads only the private, exact capture. */
export async function sqlNativeCaptureForPreparation(attempt: SqlIngestionAttempt, receipt: AuthenticatedSqlRunReceipt) {
  const capture = captureOf(attempt, receipt);
  await assertSqlIngestionAttemptCurrent(attempt);
  return {input: structuredClone(capture.input), payload: deserialize(serialize(capture.payload)) as Payload};
}

/** Native DDL/owner recheck is mandatory after model work and outside SQL. */
export async function finalizeSqlNativeCapture(attempt: SqlIngestionAttempt, receipt: AuthenticatedSqlRunReceipt) {
  const capture = captureOf(attempt, receipt);
  invariant(!capture.finalized, 409, "SQL_NATIVE_RECEIPT_INVALID", "Native SQL capture was already finalized.");
  capture.finalized = true;
  await capture.native.beforePublication();
  await assertSqlIngestionAttemptCurrent(attempt);
  const source = await sqlIngestionSourceForCapture(attempt);
  const parents = freeze({rows: capture.payload.rows.map(({table, definition, values, primaryKey}) => ({table, definition, values, primaryKey})),
    pages: capture.payload.pages});
  const allowed = await getRegisteredSqlNativeAccessValidator(source.driverType)({source, parents,
    assertCurrentSource: () => assertSqlIngestionAttemptCurrent(attempt)});
  invariant(allowed === true, 409, "SQL_NATIVE_CAPTURE_ACCESS_REVOKED", "Native SQL source access changed after model preparation.");
  await assertSqlIngestionAttemptCurrent(attempt);
}

export async function disposeSqlIngestionCapture(receipt: AuthenticatedSqlRunReceipt) {
  const capture = captures.get(receipt);
  if (!capture || capture.disposed) return;
  capture.disposed = true;
  try {await capture.native.dispose();}
  finally {captures.delete(receipt);}
}

/** Every delivery checks original vectors and current source authority. A native
 * receipt is never a permanent membership, role, circle or source-access grant. */
export async function isSqlNativeRunInputLocallyCurrent(actor: AppActor, workspaceId: string,
  input: SqlNativeRunInput, db: Db = prisma) {
  try {
    const proof = parsePermissionEpochProof(input.permissionEpochsJson);
    if (input.workspaceId !== workspaceId || !proof || !await isArtifactPermissionEpochProofCurrent(workspaceId, proof, db)) return false;
    const [source, attempt] = await Promise.all([
      db.externalDataSource.findFirst({where: {id: input.sourceId, workspaceId}}),
      db.sqlIngestionAttempt.findFirst({where: {id: input.attemptId, workspaceId, sourceId: input.sourceId}}),
    ]);
    if (!source || !attempt || attempt.status !== "SUCCEEDED" || attempt.generation !== input.generation
      || attempt.configurationFingerprint !== input.configurationFingerprint || attempt.sourcePermissionEpoch !== input.sourcePermissionEpoch
      || sqlIngestionConfigurationFingerprint(source) !== input.configurationFingerprint
      || !await canReadSqlSource(actor, workspaceId, source, db)) return false;
    originalPayload(input, source.selectedTables);
    return true;
  } catch {return false;}
}

/** Live provider SELECT/RLS/definition proof is mandatory on ordinary reads.
 * Local current membership/category guards cannot substitute for it. */
export async function isSqlNativeRunInputCurrent(actor: AppActor, workspaceId: string,
  input: SqlNativeRunInput, db: Db = prisma): Promise<boolean> {
  if (db !== prisma) {
    const {hasSqlNativeReadCommitAuthority} = await import("./sql-native-read-preflight");
    return hasSqlNativeReadCommitAuthority(actor, workspaceId, input, db)
      && await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input, db);
  }
  if (!await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input, db)) return false;
  try {
    assertOutsideArtifactNativeCommitPhase();
    const source = await prisma.externalDataSource.findFirstOrThrow({where: {id: input.sourceId, workspaceId}});
    const payload = originalPayload(input, source.selectedTables);
    const validator = getRegisteredSqlNativeAccessValidator(source.driverType);
    const parents = freeze({rows: payload.rows.map(({table, definition, values, primaryKey}) => ({table, definition, values, primaryKey})),
      pages: payload.pages});
    const valid = await validator({source: Object.freeze({...source, selectedTables: Object.freeze(source.selectedTables)}), parents,
      assertCurrentSource: async () => invariant(await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input),
        409, "SOURCE_CHANGED", "SQL source access changed during native validation.")});
    if (valid === false) {
      // An observed authenticated denial must survive provider restore and
      // process replay. Preserve original bytes/vector; only a new independent
      // native capture can replace this revoked receipt.
      const own = parsePermissionEpochProof(input.permissionEpochsJson)?.entries.find(entry =>
        entry.kind === "SqlNativeRunInput" && entry.id === input.id);
      if (own) await prisma.sourcePermissionEpoch.updateMany({where: {workspaceId,
        sourceKind: "SqlNativeRunInput", sourceId: input.id, epoch: BigInt(own.epoch)}, data: {epoch: {increment: 1n}}});
      return false;
    }
    return valid === true && await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input);
  } catch {return false;}
}

/** Real input recheck for the current publisher; terminal user-read rules above
 * deliberately cannot be used to admit a RUNNING native receipt. */
export async function assertSqlNativeCaptureCurrent(attempt: SqlIngestionAttempt,
  receipt: AuthenticatedSqlRunReceipt, tx: Prisma.TransactionClient) {
  const capture = captureOf(attempt, receipt);
  await tx.$queryRaw`SELECT id FROM "SqlNativeRunInput" WHERE id = ${capture.input.id} AND "workspaceId" = ${attempt.workspaceId} FOR SHARE`;
  // The authenticated ciphertext is immutable by database trigger. A held row,
  // exact original header/hash and monotonic original epochs fence delete/recreate
  // without transferring the complete encrypted run for every staged batch.
  const select = {id: true, workspaceId: true, sourceId: true, attemptId: true, generation: true,
    configurationFingerprint: true, sourcePermissionEpoch: true, permissionEpochsJson: true,
    payloadHash: true, rowsProcessed: true, nextCursor: true, createdAt: true} as const;
  const stored = await tx.sqlNativeRunInput.findUnique({where: {id: capture.input.id}, select});
  const expected = Object.fromEntries(Object.keys(select).map(key => [key, capture.input[key as keyof SqlNativeRunInput]]));
  const original = parsePermissionEpochProof(capture.input.permissionEpochsJson);
  invariant(original, 409, "SQL_INGESTION_FENCE_LOST", "Native SQL input lost its original vector.");
  const held = await capturePermissionEpochs(tx, attempt.workspaceId, original.entries);
  invariant(stored && isDeepStrictEqual(stored, expected)
    && isDeepStrictEqual(held, original)
    && await isArtifactPermissionEpochProofCurrent(attempt.workspaceId, stored.permissionEpochsJson, tx),
  409, "SQL_INGESTION_FENCE_LOST", "Native SQL source evidence changed before publication.");
}

/** Staging is not serving authority. Exact published membership and immutable
 * output bytes are checked before content, ranks, counts or context can escape. */
export async function isSqlKnowledgeChunkPublished(workspaceId: string, row: Record<string, unknown>, db: Db = prisma) {
  const metadata = row.metadata as Record<string, unknown> | null;
  if (!metadata || typeof metadata.sqlPublicationId !== "string" || typeof metadata.nativeInputId !== "string"
    || typeof row.id !== "string") return false;
  const [publication, output] = await Promise.all([
    db.sqlKnowledgePublication.findFirst({where: {id: metadata.sqlPublicationId, workspaceId,
      nativeInputId: metadata.nativeInputId, status: "COMMITTED"}}),
    db.sqlKnowledgeStagedChunk.findFirst({where: {id: row.id, publicationId: metadata.sqlPublicationId}}),
  ]);
  if (!publication?.committedAt || !output) return false;
  const {lineageContentFingerprint} = await import("./source-lineage");
  return output.contentHash === lineageContentFingerprint("KnowledgeChunk", row)
    && output.contentHash === lineageContentFingerprint("KnowledgeChunk", output.contentJson);
}
