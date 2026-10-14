import { isDeepStrictEqual } from "node:util";
import type { ArtifactInputSnapshot, Prisma } from "@prisma/client";

const MAX_ROWS = 64;
const MAX_BYTES = 128 * 1024;
// Conservative retained-size accounting, stopping before visiting a large JSON
// payload. Never stringify/copy an oversized native transcript or SQL snapshot.
function retainedSize(value: unknown, budget: number, depth = 0): number {
  if (depth > 32 || budget < 0) return Infinity;
  if (typeof value === "string") return 24 + value.length * 2;
  if (value === null || typeof value !== "object") return 16;
  if (value instanceof Date) return 32;
  let size = 64;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    size += 64 + key.length * 2;
    size += retainedSize((value as Record<string, unknown>)[key], budget - size, depth + 1);
    if (size > budget) return Infinity;
  }
  return size;
}

/** A bounded set of bytes already read by ONE dependency/coverage inspection.
 * Not an authority cache or transaction scope. Reuse requires a final fresh SQL
 * comparison: snapshot payloads are not immutable at the database level. */
export class BoundedSnapshotReads {
  private readonly rows = new Map<string, ArtifactInputSnapshot>();
  private remainingBytes = MAX_BYTES;
  private finished = false;

  constructor(private readonly db: Prisma.TransactionClient, private readonly workspaceId: string) {}

  retain(row: ArtifactInputSnapshot) {
    if (this.finished || row.workspaceId !== this.workspaceId || this.rows.has(row.id) || this.rows.size >= MAX_ROWS) return;
    // Native/SQL/Knowledge payloads never enter this local receipt optimization.
    if (["SqlNativeRunInput", "KnowledgeChunk", "NativeTranscriptInput", "ExternalProviderFetchInput",
      "ExternalMcpResponseInput", "CommunicationMessageNativeInput", "FinanceReportUploadInput"].includes(row.sourceKind)) return;
    const size = retainedSize(row, this.remainingBytes);
    if (size > this.remainingBytes) return;
    this.remainingBytes -= size;
    this.rows.set(row.id, structuredClone(row));
  }

  get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async isCurrent(): Promise<boolean> {
    if (this.finished) return false;
    try {
      if (!this.rows.size) return true;
      const fresh = await this.db.artifactInputSnapshot.findMany({ where: { workspaceId: this.workspaceId, id: { in: [...this.rows.keys()] } } });
      return fresh.length === this.rows.size && fresh.every(row => isDeepStrictEqual(row, this.rows.get(row.id)));
    } finally {
      this.finished = true;
      this.rows.clear();
    }
  }
}
