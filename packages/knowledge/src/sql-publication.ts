import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type KnowledgeChunk, type SqlKnowledgePublication } from "@prisma/client";
import { getSharedStateBackend, prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { assertArtifactInputWriteFence } from "../../domain/src/artifact-input-write-fence";
import { AppError } from "../../domain/src/errors";
import { assertSqlIngestionAttemptCurrent, completeSqlIngestionAttempt, lockSqlIngestionAttempt,
  renewSqlIngestionAttempt } from "../../domain/src/sql-ingestion-attempt";
import { assertSqlNativeCaptureCurrent, disposeSqlIngestionCapture, finalizeSqlNativeCapture,
  sqlNativeCaptureForPreparation } from "../../domain/src/sql-native-input";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, mergePermissionEpochProofs,
  parsePermissionEpochProof } from "../../domain/src/source-permission-epochs";
import { lineageContentFingerprint, type LineageRoot } from "../../domain/src/source-lineage";
import { sourceCommitCanonical } from "../../domain/src/source-commit-lock-plan";
import type { AuthenticatedSqlRunReceipt, CommittedSqlKnowledgePublication, PreparedSqlKnowledgeAttempt,
  SqlIngestionAttempt, SqlKnowledgePublicationPort, SqlPublicationIdentity } from "@corgtex/domain/sql-ingestion-contract";
import { chunkText } from "./chunks";
import { classifyChunkSensitivity } from "./sensitivity";
import { invalidateKnowledgeCache } from "./retrieval";

// Vector batches also bound JSON copies and persisted-row verification. Identity-only
// pages can stay larger without retaining embeddings across an application query.
const VECTOR_BATCH_SIZE = 128;
const IDENTITY_BATCH_SIZE = 500;
const MAX_CHUNKS = 100_000;
type Output = {row: KnowledgeChunk; rowIndex: number; hash: string};
type OutputIdentity = {id: string; rowIndex: number; hash: string};
type Preparation = {attempt: SqlIngestionAttempt; receipt: AuthenticatedSqlRunReceipt;
  publication: SqlKnowledgePublication; outputs: OutputIdentity[]; root: LineageRoot; rowIds: string[]};
const preparations = new WeakMap<PreparedSqlKnowledgeAttempt, Preparation>();
const digest = (outputs: readonly OutputIdentity[]) => createHash("sha256").update(sourceCommitCanonical(
  outputs.map((output, ordinal) => ({...output, ordinal})))).digest("hex");
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

/** Models run outside every application transaction. The complete bounded output
 * set is declared before staging; staging has no Knowledge serving authority. */
export async function prepareSqlKnowledgeAttempt(input: {attempt: SqlIngestionAttempt;
  receipt: AuthenticatedSqlRunReceipt}): Promise<PreparedSqlKnowledgeAttempt> {
  const {attempt, receipt} = input;
  try {
    const capture = await sqlNativeCaptureForPreparation(attempt, receipt);
    const source = await prisma.externalDataSource.findFirstOrThrow({where: {id: attempt.sourceId, workspaceId: attempt.workspaceId}});
    const publicationId = randomUUID(), createdAt = new Date();
    const sourceContentHash = capture.fingerprint;
    const root: LineageRoot = {kind: "SqlNativeRunInput", id: capture.input.id, fingerprint: sourceContentHash,
      permissionEpochs: parsePermissionEpochProof(capture.input.permissionEpochsJson)!};
    const rowIds = capture.payload.rows.map(row => `byodb:${attempt.sourceId}:${row.table}:${row.primaryKey}`);
    const outputs: Output[] = capture.payload.rows.flatMap((native, rowIndex) => chunkText(native.content).map((content, chunkIndex) => {
      const sensitivity = classifyChunkSensitivity(content);
      const row: KnowledgeChunk = {id: randomUUID(), workspaceId: attempt.workspaceId, sourceType: "EXTERNAL_DATABASE",
        accessDomain: source.accessDomain, sourceId: rowIds[rowIndex], sourceTitle: `${native.table} row ${native.primaryKey}`,
        chunkIndex, content, embedding: null, metadata: {table: native.table, sourceId: attempt.sourceId,
          nativeInputId: capture.input.id, sqlPublicationId: publicationId, nativeRowIndex: rowIndex,
          sourceContentHash, chunkIndex, sourceType: "EXTERNAL_DATABASE", sensitivityPatterns: sensitivity.matchedPatterns},
        tokenCount: content.length, embeddingModel: null, sensitivity: sensitivity.label, createdAt};
      return {row, rowIndex, hash: ""};
    }));
    invariant(outputs.length <= MAX_CHUNKS && (capture.payload.rows.length === 0 || outputs.length > 0),
      "SQL_PUBLICATION_OUTPUT_LIMIT", "SQL run exceeds the bounded complete output set.");
    let publication = await prisma.$transaction(async tx => {
      await lockSqlIngestionAttempt(attempt, tx);
      await assertSqlNativeCaptureCurrent(attempt, receipt, tx);
      return tx.sqlKnowledgePublication.create({data: {id: publicationId, workspaceId: attempt.workspaceId,
        sourceId: attempt.sourceId, attemptId: attempt.attemptId, nativeInputId: capture.input.id,
        generation: BigInt(attempt.generation), configurationFingerprint: attempt.configurationFingerprint,
        outputSetHash: "", chunksCreated: outputs.length, rowsProcessed: capture.payload.rowsProcessed, nextCursor: capture.payload.nextCursor}});
    }, {timeout: 10_000});
    for (let offset = 0; offset < outputs.length; offset += VECTOR_BATCH_SIZE) {
      const batch = outputs.slice(offset, offset + VECTOR_BATCH_SIZE);
      await assertSqlIngestionAttemptCurrent(attempt);
      const embedded = await defaultModelGateway.embed({workspaceId: attempt.workspaceId, input: batch.map(output => output.row.content)});
      await assertSqlIngestionAttemptCurrent(attempt);
      invariant(embedded.embeddings.length === batch.length && embedded.embeddings.every(vector =>
        Array.isArray(vector) && vector.length > 0 && vector.every(value => Number.isFinite(value))),
      "SQL_PUBLICATION_EMBEDDING_INVALID", "SQL model preparation did not return the complete embedding set.");
      batch.forEach((output, index) => {
        output.row.embedding = embedded.embeddings[index]; output.row.embeddingModel = embedded.usage.model;
        output.hash = lineageContentFingerprint("KnowledgeChunk", output.row);
      });
      await prisma.$transaction(async tx => {
        await lockSqlIngestionAttempt(attempt, tx);
        await assertSqlNativeCaptureCurrent(attempt, receipt, tx);
        await tx.sqlKnowledgeStagedChunk.createMany({data: batch.map((output, index) => ({id: output.row.id,
          publicationId, ordinal: offset + index, rowIndex: output.rowIndex, contentHash: output.hash, contentJson: json(output.row)}))});
      }, {timeout: 10_000});
      // Staging is immutable and has no serving authority. Retain only the
      // complete descriptor/hash set; vectors never accumulate across batches.
      batch.forEach(output => {output.row.embedding = null;});
    }
    const identities = outputs.map(output => ({id: output.row.id, rowIndex: output.rowIndex, hash: output.hash}));
    publication = await prisma.$transaction(async tx => {
      await lockSqlIngestionAttempt(attempt, tx);
      await assertSqlNativeCaptureCurrent(attempt, receipt, tx);
      const count = await tx.sqlKnowledgeStagedChunk.count({where: {publicationId}});
      invariant(count === outputs.length, "SQL_PUBLICATION_SET_CHANGED", "SQL staged set is incomplete.");
      return tx.sqlKnowledgePublication.update({where: {id: publicationId}, data: {status: "PREPARED", outputSetHash: digest(identities)}});
    }, {timeout: 10_000});
    const prepared = Object.freeze({preparationId: publicationId}) as PreparedSqlKnowledgeAttempt;
    preparations.set(prepared, {attempt, receipt, publication, outputs: identities, root, rowIds});
    return prepared;
  } catch (error) {await disposeSqlIngestionCapture(receipt).catch(() => undefined); throw error;}
}

function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(409, code, message);
}

/** Dedicated fixed native publication executor. Immutable staging provides one
 * complete collection authority even when row+chunk identities exceed 10k. All
 * publication, lineage, checkpoint, status and PostgreSQL cache effects commit
 * together. No provider or model callback is admitted inside this transaction. */
export async function publishPreparedSqlKnowledgeAttempt(input: Parameters<SqlKnowledgePublicationPort["publishPreparedSqlKnowledgeAttempt"]>[0])
  : Promise<CommittedSqlKnowledgePublication> {
  const state = preparations.get(input.prepared);
  invariant(state && state.attempt === input.attempt, "SQL_PUBLICATION_PREPARATION_INVALID", "SQL publication has no exact preparation.");
  preparations.delete(input.prepared);
  const {attempt, receipt, outputs, root, publication} = state;
  try {
    await input.beforePublication?.();
    await finalizeSqlNativeCapture(attempt, receipt);
    await renewSqlIngestionAttempt(attempt);
    const identity: SqlPublicationIdentity = Object.freeze({publicationId: publication.id, workspaceId: attempt.workspaceId,
      sourceId: attempt.sourceId, attemptId: attempt.attemptId, generation: attempt.generation,
      configurationFingerprint: attempt.configurationFingerprint, rowsProcessed: publication.rowsProcessed,
      chunksCreated: publication.chunksCreated, nextCursor: publication.nextCursor});
    await prisma.$transaction(async tx => {
      await lockSqlIngestionAttempt(attempt, tx);
      await assertArtifactInputWriteFence(tx);
      await assertSqlNativeCaptureCurrent(attempt, receipt, tx);
      await tx.$queryRaw`SELECT id FROM "SqlKnowledgePublication" WHERE id = ${publication.id} FOR UPDATE`;
      const current = await tx.sqlKnowledgePublication.findUnique({where: {id: publication.id}});
      invariant(current && isDeepStrictEqual(current, publication), "SQL_PUBLICATION_SET_CHANGED", "SQL publication identity changed.");
      const staged = await tx.sqlKnowledgeStagedChunk.findMany({where: {publicationId: publication.id}, orderBy: {ordinal: "asc"},
        select: {id: true, ordinal: true, rowIndex: true, contentHash: true}});
      invariant(staged.length === outputs.length && staged.every((row, index) => row.ordinal === index
        && row.id === outputs[index].id && row.rowIndex === outputs[index].rowIndex && row.contentHash === outputs[index].hash)
        && digest(outputs) === publication.outputSetHash, "SQL_PUBLICATION_SET_CHANGED", "SQL output set changed before publication.");
      // Native identities remain the historical namespace. This incremental run
      // replaces only the rows it actually captured; it never invents a resync.
      for (let offset = 0; offset < state.rowIds.length; offset += IDENTITY_BATCH_SIZE) await tx.knowledgeChunk.deleteMany({where: {
        workspaceId: attempt.workspaceId, sourceType: "EXTERNAL_DATABASE", sourceId: {in: state.rowIds.slice(offset, offset + IDENTITY_BATCH_SIZE)}}});
      for (let offset = 0; offset < outputs.length; offset += VECTOR_BATCH_SIZE) {
        const planned = outputs.slice(offset, offset + VECTOR_BATCH_SIZE);
        const stored = await tx.sqlKnowledgeStagedChunk.findMany({where: {publicationId: publication.id,
          ordinal: {gte: offset, lt: offset + planned.length}}, orderBy: {ordinal: "asc"}});
        invariant(stored.length === planned.length && stored.every((entry, index) => entry.id === planned[index].id
          && entry.rowIndex === planned[index].rowIndex && entry.contentHash === planned[index].hash
          && lineageContentFingerprint("KnowledgeChunk", entry.contentJson) === entry.contentHash),
        "SQL_PUBLICATION_SET_CHANGED", "SQL staged batch differs from the complete planned set.");
        const batch = stored.map((entry, index) => ({...planned[index], row: {
          ...(entry.contentJson as Prisma.JsonObject), createdAt: new Date(String((entry.contentJson as Prisma.JsonObject).createdAt)),
        } as unknown as KnowledgeChunk}));
        await tx.knowledgeChunk.createMany({data: batch.map(output => ({...output.row, embedding: output.row.embedding ?? Prisma.JsonNull,
          metadata: output.row.metadata ?? Prisma.JsonNull}))});
        const inserted = await tx.knowledgeChunk.findMany({where: {id: {in: batch.map(output => output.row.id)}, workspaceId: attempt.workspaceId}});
        const byId = new Map(inserted.map(row => [row.id, row]));
        invariant(inserted.length === batch.length && batch.every(output => isDeepStrictEqual(output.row, byId.get(output.row.id))),
          "SQL_PUBLICATION_SET_CHANGED", "Persisted SQL chunks differ from their sealed output set.");
        const own = await capturePermissionEpochs(tx, attempt.workspaceId, batch.flatMap(output =>
          artifactPermissionEpochIdentities("KnowledgeChunk", output.row as unknown as Record<string, unknown>)));
        const ownEpochs = new Map(own.entries.map(entry => [JSON.stringify([entry.kind, entry.id]), entry]));
        await tx.artifactInputLineage.createMany({data: batch.map(output => {
          const entries = artifactPermissionEpochIdentities("KnowledgeChunk", output.row as unknown as Record<string, unknown>)
            .map(entry => ownEpochs.get(JSON.stringify([entry.kind, entry.id]))!);
          const proof = mergePermissionEpochProofs(root.permissionEpochs, {...own, entries: entries.sort((a, b) =>
            JSON.stringify([a.kind, a.id]) < JSON.stringify([b.kind, b.id]) ? -1 : 1)})!;
          return {workspaceId: attempt.workspaceId, artifactType: "KnowledgeChunk", artifactId: output.row.id, revision: 1,
            origin: "DERIVED", contentHash: output.hash, inputsJson: [{kind: root.kind, id: root.id}], rootsJson: json([root]),
            epochProofVersion: 1, permissionEpochsJson: json(proof)};
        })});
      }
      const committedManifests = await capturePublicationManifestStamps(tx, attempt.workspaceId, outputs.map(output => output.id));
      if (getSharedStateBackend() === "postgres") await invalidateKnowledgeCache(attempt.workspaceId, tx);
      await input.commit(tx, identity);
      await assertArtifactInputWriteFence(tx);
      await assertSqlNativeCaptureCurrent(attempt, receipt, tx);
      await assertSqlIngestionAttemptCurrent(attempt, tx, {publishedCursor: identity.nextCursor});
      for (let offset = 0; offset < outputs.length; offset += VECTOR_BATCH_SIZE) {
        const batch = outputs.slice(offset, offset + VECTOR_BATCH_SIZE), ids = batch.map(output => output.id);
        const [rows, manifests] = await Promise.all([
          tx.knowledgeChunk.findMany({where: {workspaceId: attempt.workspaceId, id: {in: ids}}}),
          capturePublicationManifestStamps(tx, attempt.workspaceId, ids),
        ]);
        const byId = new Map(rows.map(row => [row.id, row]));
        const expected = committedManifests.filter(manifest => ids.includes(manifest.id)).sort((a, b) => a.id.localeCompare(b.id));
        invariant(rows.length === batch.length && batch.every(output => lineageContentFingerprint("KnowledgeChunk", byId.get(output.id)) === output.hash)
          && expected.length === batch.length && isDeepStrictEqual(expected, manifests.sort((a, b) => a.id.localeCompare(b.id))),
        "SQL_PUBLICATION_SET_CHANGED", "Checkpoint callback changed the declared SQL output or lineage set.");
      }
      const log = await tx.externalDataSyncLog.findFirst({where: {id: attempt.logId, sourceId: attempt.sourceId,
        sqlAttemptId: attempt.attemptId, completedAt: {not: null}, error: null,
        rowsProcessed: identity.rowsProcessed, chunksCreated: identity.chunksCreated}});
      invariant(log, "SQL_PUBLICATION_CHECKPOINT_INVALID", "SQL checkpoint callback did not complete its own success log.");
      await tx.sqlKnowledgePublication.update({where: {id: publication.id}, data: {status: "COMMITTED", committedAt: new Date()}});
      await completeSqlIngestionAttempt(attempt, tx, identity.nextCursor);
    }, {timeout: 120_000});
    if (getSharedStateBackend() !== "postgres") await invalidateKnowledgeCache(attempt.workspaceId);
    return Object.freeze({...identity, committed: true});
  } finally {await disposeSqlIngestionCapture(receipt).catch(() => undefined);}
}

async function capturePublicationManifestStamps(tx: Prisma.TransactionClient, workspaceId: string, ids: string[]) {
  if (!ids.length) return [] as Array<{id: string; stamp: string}>;
  return tx.$queryRaw<Array<{id: string; stamp: string}>>(Prisma.sql`SELECT "artifactId" AS id,
    encode(sha256(convert_to(to_jsonb(l)::text, 'UTF8')), 'hex') AS stamp FROM "ArtifactInputLineage" l
    JOIN jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) expected(id) ON expected.id = l."artifactId"
    WHERE "workspaceId" = ${workspaceId} AND "artifactType" = 'KnowledgeChunk'`);
}
