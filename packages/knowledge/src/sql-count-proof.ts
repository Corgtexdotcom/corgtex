import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { LineageRoot } from "@corgtex/domain";
import { mergePermissionEpochProofs, parsePermissionEpochProof } from "../../domain/src/source-permission-epochs";
import { isPublishedSqlKnowledgeVector } from "../../domain/src/source-permission-coverage";
import { getMcpOrigin } from "../../shared/src/mcp-context";

export type SqlCountStamp = { id: string; stamp: string };
export type SqlCountEpoch = { kind: string; id: string; epoch: string };
const hash = (value: Prisma.Sql) => Prisma.sql`encode(sha256(convert_to(${value}, 'UTF8')), 'hex')`;
const rowStamp = hash(Prisma.sql`jsonb_build_array(to_jsonb(k), to_jsonb(m))::text`);
const latestManifest = Prisma.sql`LEFT JOIN LATERAL (
  SELECT * FROM "ArtifactInputLineage" l WHERE l."workspaceId" = k."workspaceId"
  AND l."artifactType" = 'KnowledgeChunk' AND l."artifactId" = k.id ORDER BY l.revision DESC LIMIT 1
) m ON true`;

/** Canonical immutable publication admission without shipping stored vectors to
 * Node. Staging was authenticated and sealed by the fixed publisher; compare
 * every persisted field to those original staged bytes and validate the exact
 * original native/child vector. Final live native authorization is mandatory. */
export async function captureSqlCountPageProof(workspaceId: string, ids: readonly string[], sourceRoots: readonly LineageRoot[],
  db: Prisma.TransactionClient = prisma) {
  if (getMcpOrigin()) return undefined;
  if (!ids.length) return [] as LineageRoot[];
  if (ids.length > 500) throw Object.assign(new Error("SQL count requires bounded pages."), {code: "KNOWLEDGE_COUNT_LIMIT", status: 409});
  const rows = await db.$queryRaw<Array<{id: string; metadata: Prisma.JsonValue; workspaceId: string;
    sourceId: string; sourceType: string; accessDomain: string; hash: string; roots: LineageRoot[];
    epochs: unknown; nativeEpochs: unknown}>>(Prisma.sql`SELECT k.id, k.metadata, k."workspaceId", k."sourceId",
      k."sourceType", k."accessDomain", s."contentHash" AS hash, m."rootsJson" AS roots,
      m."permissionEpochsJson" AS epochs, i."permissionEpochsJson" AS "nativeEpochs"
    FROM "KnowledgeChunk" k ${latestManifest}
    JOIN "SqlNativeRunInput" i ON i.id = k.metadata->>'nativeInputId' AND i."workspaceId" = k."workspaceId"
    JOIN "SqlKnowledgePublication" p ON p.id = k.metadata->>'sqlPublicationId' AND p."workspaceId" = k."workspaceId"
      AND p."nativeInputId" = i.id AND p."sourceId" = i."sourceId" AND p."attemptId" = i."attemptId"
      AND p.generation = i.generation AND p."configurationFingerprint" = i."configurationFingerprint"
      AND p.status = 'COMMITTED' AND p."committedAt" IS NOT NULL
    JOIN "SqlKnowledgeStagedChunk" s ON s.id = k.id AND s."publicationId" = p.id
    JOIN "SourcePermissionEpoch" own_epoch ON own_epoch."workspaceId" = k."workspaceId"
      AND own_epoch."sourceKind" = 'KnowledgeChunk' AND own_epoch."sourceId" = k.id
    WHERE k."workspaceId" = ${workspaceId} AND k.id IN (${Prisma.join(ids)})
      AND k."sourceType" = 'EXTERNAL_DATABASE'
      AND to_jsonb(k)-'createdAt'-'vectorEmbedding' = s."contentJson"-'createdAt'
      -- Prisma stores UTC instants in timestamp-without-zone columns. The
      -- staged ISO instant must use that same UTC representation, independently
      -- of the application's PostgreSQL session TimeZone.
      AND k."createdAt" = ((s."contentJson"->>'createdAt')::timestamptz AT TIME ZONE 'UTC')
      AND m.origin = 'DERIVED' AND m."contentHash" = s."contentHash" AND m."epochProofVersion" = 1
      AND m."inputsJson" = jsonb_build_array(jsonb_build_object('kind','SqlNativeRunInput','id',i.id))
      AND m."permissionEpochsJson"->'entries' @> jsonb_build_array(jsonb_build_object(
        'kind','KnowledgeChunk','id',k.id,'epoch',own_epoch.epoch::text))`);
  const sources = new Map(sourceRoots.map(root => [root.id, root]));
  const proof: LineageRoot[] = [];
  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null;
    const source = metadata && sources.get(String(metadata.nativeInputId));
    if (!source || source.fingerprint !== metadata?.sourceContentHash || !Array.isArray(row.roots)
      || !isPublishedSqlKnowledgeVector(row.id, row, row.roots, row.epochs, row.nativeEpochs)) continue;
    const original = parsePermissionEpochProof(row.epochs), caller = parsePermissionEpochProof(source.permissionEpochs);
    if (!original || !caller) continue;
    proof.push({kind: "KnowledgeChunk", id: row.id, fingerprint: row.hash,
      permissionEpochs: mergePermissionEpochProofs(original, caller)});
  }
  return proof;
}

/** Read-only change detection, never an admission or publication capability. The
 * full SQL row and latest manifest are hashed on the database to keep vectors
 * out of the complete count ledger. */
export async function captureSqlCountStamps(workspaceId: string, ids: readonly string[]) {
  if (!ids.length) return [] as SqlCountStamp[];
  return prisma.$queryRaw<SqlCountStamp[]>(Prisma.sql`SELECT k.id, ${rowStamp} AS stamp
    FROM "KnowledgeChunk" k ${latestManifest}
    WHERE k."workspaceId" = ${workspaceId} AND k.id IN (${Prisma.join(ids)})`);
}

export function retainSqlCountEpochs(ledger: Map<string, SqlCountEpoch>, roots: readonly LineageRoot[]) {
  for (const root of roots) {
    const proof = parsePermissionEpochProof(root.permissionEpochs);
    if (!proof) throw Object.assign(new Error("SQL count input lacks original permission epochs."), {code: "UNKNOWN_LINEAGE", status: 409});
    for (const entry of proof.entries) {
      const key = JSON.stringify([entry.kind, entry.id]), earlier = ledger.get(key);
      if (earlier && earlier.epoch !== entry.epoch) throw Object.assign(new Error("SQL count input permissions changed."), {code: "SOURCE_CHANGED", status: 409});
      ledger.set(key, entry);
    }
    if (ledger.size > 300_000) throw Object.assign(new Error("SQL count permission closure exceeds its complete bound."),
      {code: "KNOWLEDGE_COUNT_LIMIT", status: 409});
  }
}

const nativeCollection = (workspaceId: string, domains: readonly string[]) => Prisma.sql`SELECT DISTINCT i.id
  FROM "SqlNativeRunInput" i JOIN "SqlKnowledgePublication" p
  ON p."nativeInputId" = i.id AND p."workspaceId" = i."workspaceId" AND p.status = 'COMMITTED'
  WHERE i."workspaceId" = ${workspaceId} AND EXISTS (SELECT 1 FROM "KnowledgeChunk" k
    WHERE k."workspaceId" = i."workspaceId" AND k."sourceType" = 'EXTERNAL_DATABASE'
    AND k.metadata->>'nativeInputId' = i.id AND k.metadata->>'sqlPublicationId' = p.id
    AND k."accessDomain"::text IN (${Prisma.join(domains)}))`;
const collectionStamp = (workspaceId: string, domains: readonly string[]) =>
  Prisma.sql`(SELECT ${hash(Prisma.sql`coalesce(jsonb_agg(id ORDER BY id COLLATE "C"), '[]'::jsonb)::text`)}
    FROM (${nativeCollection(workspaceId, domains)}) native_ids)`;

export async function captureSqlCountCollection(workspaceId: string, domains: readonly string[]) {
  const [row] = await prisma.$queryRaw<Array<{stamp: string}>>(Prisma.sql`SELECT ${collectionStamp(workspaceId, domains)} AS stamp`);
  return row.stamp;
}

/** One final database observation checks the entire admitted collection and
 * original epoch union after the last remote authorization. This fixed executor
 * has its own bounded ledger; it does not enlarge generic lineage/root budgets. */
export async function isSqlCountLedgerCurrent(workspaceId: string, domains: readonly string[],
  collection: string, stamps: readonly SqlCountStamp[], epochs: readonly SqlCountEpoch[],
  sources: readonly {id: string; hash: string}[], db: Prisma.TransactionClient = prisma) {
  if (stamps.length > 100_000 || epochs.length > 300_000) return false;
  const [row] = await db.$queryRaw<Array<{current: boolean}>>(Prisma.sql`
    WITH expected_rows AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(stamps)}::jsonb) AS r(id text, stamp text)),
    expected_sources AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(sources)}::jsonb) AS s(id text, hash text)),
    expected_epochs AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(epochs)}::jsonb) AS e(kind text, id text, epoch text))
    SELECT ${collectionStamp(workspaceId, domains)} = ${collection}
      AND (SELECT count(*) FROM "KnowledgeChunk" k JOIN expected_sources s
        ON k.metadata->>'nativeInputId' = s.id AND k.metadata->>'sourceContentHash' = s.hash
        WHERE k."workspaceId" = ${workspaceId} AND k."sourceType" = 'EXTERNAL_DATABASE'
        AND k."accessDomain"::text IN (${Prisma.join(domains)})) = ${stamps.length}
      AND (SELECT count(DISTINCT r.id) FROM expected_rows r JOIN "KnowledgeChunk" k
        ON k.id = r.id AND k."workspaceId" = ${workspaceId} ${latestManifest}
        WHERE ${rowStamp} = r.stamp) = ${stamps.length}
      AND (SELECT count(*) FROM expected_epochs e JOIN "SourcePermissionEpoch" p
        ON p."workspaceId" = ${workspaceId} AND p."sourceKind" = e.kind AND p."sourceId" = e.id
        WHERE p.epoch::text = e.epoch) = ${epochs.length} AS current`);
  return row.current;
}
