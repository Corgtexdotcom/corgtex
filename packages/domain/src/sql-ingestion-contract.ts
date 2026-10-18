import type { Prisma } from "@prisma/client";

/** Brands do not mint runtime authority. Trusted claim/capture implementations
 * require exact private token identity. */
declare const attemptBrand: unique symbol;
declare const receiptBrand: unique symbol;
declare const preparedBrand: unique symbol;
export type SqlIngestionAttempt = Readonly<{[attemptBrand]: true; attemptId: string;
  workspaceId: string; sourceId: string; generation: string; configurationFingerprint: string; logId: string}>;
export type AuthenticatedSqlRunReceipt = Readonly<{[receiptBrand]: true; receiptId: string}>;
export type PreparedSqlKnowledgeAttempt = Readonly<{[preparedBrand]: true; preparationId: string}>;

export type SqlSourceConfiguration = Readonly<{id: string; workspaceId: string; driverType: string;
  connectionStringEnc: string; selectedTables: readonly string[]; cursorColumn: string;
  lastCursorValue: string | null; isActive: boolean; archivedAt: Date | null}>;
export type SqlNativeType = "int2" | "int4" | "int8" | "numeric" | "date" | "timestamp"
  | "timestamptz" | "uuid" | "text" | "varchar" | "bpchar";
export type SqlNativeColumn = Readonly<{name: string; type: SqlNativeType; typeOid: number;
  typeModifier: number; collationOid: number}>;
/** Ordered complete native SELECT * shape from pg_attribute/pg_type, including
 * payload columns. These are captured by the trusted native driver, never
 * reconstructed from rendered model text. Key/cursor types remain bounded. */
export type SqlNativeCapturedColumn = Readonly<{name: string; type: string; typeOid: number;
  typeModifier: number; collationOid: number; position: number; isNullable: boolean;
  identity: string; generated: string}>;
export type SqlNativeDefinition = Readonly<{schema: string; name: string; relationOid: number;
  cursor: SqlNativeColumn; key: readonly SqlNativeColumn[]; columns: readonly SqlNativeCapturedColumn[]}>;
export type SqlNativeRow = Readonly<{
  /** Exact actual driver row, retained separately from rendered model content. */
  row: Readonly<Record<string, unknown>>; table: string; definition: SqlNativeDefinition;
  values: readonly string[]; primaryKey: string; content: string;
}>;
export type SqlNativePage = Readonly<{table: string; definition: SqlNativeDefinition;
  previous: readonly string[] | null; rowCount: number; tail: readonly string[] | null}>;
export type SqlNativeDriverResult = Readonly<{rows: readonly SqlNativeRow[]; pages: readonly SqlNativePage[];
  rowsProcessed: number; nextCursor: string | null;
  /** Receiver-independent trusted closures: capture retains hooks independently
   * of the returned row container. Recheck actual DDL and current attempt AFTER
   * models, then close provider. */
  beforePublication(): Promise<void>;
  /** Idempotent close on success, preparation error, lease loss or cancellation. */
  dispose(): Promise<void>;
}>;
/** Registered trusted connector code owns the real provider scan. The source is
 * loaded/sealed by the claim authority; application callers never supply rows. */
export type SqlNativeDriver = (input: Readonly<{source: SqlSourceConfiguration;
  attempt: SqlIngestionAttempt; assertCurrentSource(): Promise<void>}>) => Promise<SqlNativeDriverResult>;

/** Authenticated current provider SELECT/RLS/definition admission for precisely
 * these native parents. It receives no rendered content and mints no receipts.
 * Return true only for authenticated allowed access, false for authenticated
 * denial (which tombstones the receipt); throw for unsupported/unproved access.
 * None of those failures may fall back to local membership/category guards. */
export type SqlNativeAccessValidator = (input: Readonly<{source: SqlSourceConfiguration;
  parents: Readonly<{rows: readonly Pick<SqlNativeRow, "table" | "definition" | "values" | "primaryKey">[];
    pages: readonly SqlNativePage[]}>;
  assertCurrentSource(): Promise<void>}>) => Promise<boolean>;

export type SqlPublicationIdentity = Readonly<{publicationId: string; workspaceId: string; sourceId: string;
  attemptId: string; generation: string; configurationFingerprint: string; rowsProcessed: number;
  chunksCreated: number; nextCursor: string | null}>;
export type CommittedSqlKnowledgePublication = SqlPublicationIdentity & Readonly<{committed: true}>;

/** Runtime exports from @corgtex/domain; these type ports grant no authority. */
export interface SqlIngestionAttemptPort {
  claimSqlIngestionAttempt(input: {workspaceId: string; sourceId: string;
    expectedConfigurationFingerprint: string; expectedCursor: string | null; logId: string}): Promise<SqlIngestionAttempt>;
  /** Fixed five-minute server lease; caller renews every sixty seconds. Token,
   * nonce, generation and original proof stay unchanged. Failed renew aborts. */
  renewSqlIngestionAttempt(attempt: SqlIngestionAttempt): Promise<{leaseExpiresAt: Date}>;
  captureSqlIngestionAttempt(attempt: SqlIngestionAttempt): Promise<AuthenticatedSqlRunReceipt>;
  failSqlIngestionAttempt(input: {attempt: SqlIngestionAttempt; error: string; logId: string}): Promise<void>;
  disposeSqlIngestionCapture(receipt: AuthenticatedSqlRunReceipt): Promise<void>;
}
/** Runtime exports from @corgtex/knowledge, avoiding domain→Knowledge→
 * domain imports. No numeric return can stand in for committed publication. */
export interface SqlKnowledgePublicationPort {
  prepareSqlKnowledgeAttempt(input: {attempt: SqlIngestionAttempt;
    receipt: AuthenticatedSqlRunReceipt}): Promise<PreparedSqlKnowledgeAttempt>;
  publishPreparedSqlKnowledgeAttempt(input: {attempt: SqlIngestionAttempt; prepared: PreparedSqlKnowledgeAttempt;
    /** Stops/awaits caller heartbeat, before the private driver's mandatory DDL
     * recheck/close. This hook cannot replace native authority or run inside SQL. */
    beforePublication?: () => Promise<void>;
    /** Same real TX after chunks/lineage/cache/receipt writes, before final owner
     * and source proof checks. Cursor and own success log only. Reject rolls back. */
    commit(tx: Prisma.TransactionClient, publication: SqlPublicationIdentity): Promise<void>;
  }): Promise<CommittedSqlKnowledgePublication>;
}
