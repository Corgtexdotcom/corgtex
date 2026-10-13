import type { Prisma } from "@prisma/client";

/** Type contract only. These brands do not mint runtime authority; the future
 * trusted claim/capture implementations must check exact private token identity. */
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
export type SqlNativeDefinition = Readonly<{schema: string; name: string; relationOid: number;
  cursor: SqlNativeColumn; key: readonly SqlNativeColumn[]}>;
export type SqlNativeRow = Readonly<{
  /** Exact actual driver row, retained separately from rendered model content. */
  row: Readonly<Record<string, unknown>>; table: string; definition: SqlNativeDefinition;
  values: readonly string[]; primaryKey: string; content: string;
}>;
export type SqlNativePage = Readonly<{table: string; definition: SqlNativeDefinition;
  previous: readonly string[] | null; rowCount: number; tail: readonly string[] | null}>;
export type SqlNativeDriverResult = Readonly<{rows: readonly SqlNativeRow[]; pages: readonly SqlNativePage[];
  rowsProcessed: number; nextCursor: string | null;
  /** Recheck actual DDL and current attempt AFTER models, then close provider. */
  beforePublication(): Promise<void>;
  /** Idempotent close on success, preparation error, lease loss or cancellation. */
  dispose(): Promise<void>;
}>;
/** Registered trusted connector code owns the real provider scan. The source is
 * loaded/sealed by the claim authority; application callers never supply rows. */
export type SqlNativeDriver = (input: Readonly<{source: SqlSourceConfiguration;
  attempt: SqlIngestionAttempt; assertCurrentSource(): Promise<void>}>) => Promise<SqlNativeDriverResult>;

export type SqlPublicationIdentity = Readonly<{publicationId: string; workspaceId: string; sourceId: string;
  attemptId: string; generation: string; configurationFingerprint: string; rowsProcessed: number;
  chunksCreated: number; nextCursor: string | null}>;
export type CommittedSqlKnowledgePublication = SqlPublicationIdentity & Readonly<{committed: true}>;

/** Future runtime exports from @corgtex/domain. Not implemented by these types. */
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
/** Future runtime exports from @corgtex/knowledge, avoiding domain→Knowledge→
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
