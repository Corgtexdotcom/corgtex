export interface TransferSqlClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type TransferDisposition = "copy" | "transform" | "rebuild" | "discard" | "operator-control";

export interface TransferTablePolicy {
  disposition: TransferDisposition;
  reason: string;
  // Every populated JSON/array, object, secret and opaque reference field needs
  // an explicit disposition. Content is retained byte-for-byte, never UUID-scanned.
  fields?: Record<string, { kind: "content" | "reference" | "secret" | "object" | "effect"; reason: string; references?: { table: string; column: string } }>;
}

export interface TenantTransferManifest {
  formatVersion: 1;
  transferId: string;
  workspaceId: string;
  workspaceSlug: string;
  // The converted isolated source and target must both match this schema.
  schemaSha256: string;
  // A prepared publication binds its original snapshot and private staging payload.
  preparedFromSha256?: string;
  stagingSha256?: string;
  tables: Record<string, TransferTablePolicy>;
}

export interface TransferColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TransferForeignKey {
  // A reviewed scalar reference absent from the database FK catalog.
  declared?: true;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface TransferTableData {
  name: string;
  columns: TransferColumn[];
  primaryKey: string[];
  foreignKeys: TransferForeignKey[];
  // Each non-null value is PostgreSQL's text representation, including JSON,
  // decimal, timestamp, vector and arrays. JavaScript never parses their numbers.
  rows: (string | null)[][];
  sha256: string;
}

export interface TenantTransferSnapshot {
  formatVersion: 1;
  manifest: TenantTransferManifest;
  manifestSha256: string;
  sourceSnapshot: string;
  sourceDatabase: string;
  schemaSha256: string;
  tables: TransferTableData[];
  dispositions: { table: string; sourceRows: string; selectedRows: string; disposition: TransferDisposition; reason: string }[];
  sha256: string;
}
