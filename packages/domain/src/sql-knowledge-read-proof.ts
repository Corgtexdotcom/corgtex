import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { prisma, type AppActor } from "@corgtex/shared";
import { Prisma, type KnowledgeChunk, type SqlKnowledgeStagedChunk, type SqlNativeRunInput } from "@prisma/client";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import { isArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { isPublishedSqlKnowledgeVector } from "./source-permission-coverage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs, parsePermissionEpochProof } from "./source-permission-epochs";
import { areSqlNativeRunInputsUnchanged, isSqlNativeRunInputCurrent, isSqlNativeRunInputLocallyCurrent, loadSqlNativeRunInputs } from "./sql-native-input";
import { requireWorkspaceMembership } from "./auth";

/** Transport vector-bearing JSON as one text value rather than thousands of
 * Prisma numeric values. Parse without a reviver: JSON types and every staged
 * field remain unchanged. The temporary wire strings do not survive this read.
 */
async function loadSqlKnowledgeStages(ids: readonly string[]): Promise<SqlKnowledgeStagedChunk[]> {
  const wire = await prisma.$queryRaw<Array<Omit<SqlKnowledgeStagedChunk, "contentJson"> & {contentJson: string}>>(Prisma.sql`
    SELECT id, "publicationId", ordinal, "rowIndex", "contentHash", "contentJson"::text AS "contentJson"
    FROM "SqlKnowledgeStagedChunk" WHERE id IN (${Prisma.join([...ids])})
  `);
  return wire.map(row => ({...row, contentJson: JSON.parse(row.contentJson) as Prisma.JsonValue}));
}

/** Capture original vectors for actual current SQL candidates in one bounded
 * read. A submitted projection supplies expected bytes only; SQL rows, sealed
 * native inputs and persisted publication manifests remain authoritative. */
export async function captureSqlKnowledgeInputProof(actor: AppActor, workspaceId: string,
  candidates: readonly KnowledgeChunk[]): Promise<LineageRoot[] | null | undefined> {
  if (actor.kind !== "user" || getMcpOrigin() || isArtifactNativeCommitPhase() || !candidates.length
    || candidates.length > 5000 || candidates.some(row => row.sourceType !== "EXTERNAL_DATABASE")) return undefined;
  // The capture read owns full vector rows only until the compact proof is
  // built. Do not retain those rows throughout the independent native replay.
  const proof = await captureSqlKnowledgeRows(actor, workspaceId, candidates);
  return proof && await isSqlKnowledgeInputProofReadable(actor, workspaceId, proof) === true ? proof : null;
}

async function captureSqlKnowledgeRows(actor: Extract<AppActor, {kind: "user"}>, workspaceId: string,
  candidates: readonly KnowledgeChunk[]): Promise<LineageRoot[] | null> {
  const ids = [...new Set(candidates.map(row => row.id))];
  const [rows, manifests] = await Promise.all([
    prisma.knowledgeChunk.findMany({where: {workspaceId, id: {in: ids}}}),
    prisma.artifactInputLineage.findMany({where: {workspaceId, artifactType: "KnowledgeChunk", artifactId: {in: ids}}, orderBy: {revision: "desc"}}),
  ]);
  if (rows.length !== ids.length) return null;
  const byId = new Map(rows.map(row => [row.id, row]));
  if (candidates.some(row => lineageContentFingerprint("KnowledgeChunk", row)
    !== lineageContentFingerprint("KnowledgeChunk", byId.get(row.id)))) return null;
  const latest = new Map<string, typeof manifests[number]>();
  for (const manifest of manifests) if (!latest.has(manifest.artifactId)) latest.set(manifest.artifactId, manifest);
  const nativeIds = [...new Set(rows.map(row => (row.metadata as Record<string, unknown> | null)?.nativeInputId))];
  if (nativeIds.some(id => typeof id !== "string" || !id)) return null;
  const native = await loadSqlNativeRunInputs(workspaceId, nativeIds as string[]);
  if (native.length !== nativeIds.length) return null;
  // Hold caller policy epochs before reading membership bindings, then capture
  // that exact member's role history. No provider or model runs in this TX.
  const caller = await prisma.$transaction(async tx => {
    const ambient = await capturePermissionEpochs(tx, workspaceId, [{kind: "Workspace", id: workspaceId},
      {kind: "MemberUserPolicy", id: actor.user.id}, {kind: "WorkspaceSupportPolicy", id: actor.user.id}]);
    const member = await requireWorkspaceMembership({actor, workspaceId, tx});
    if (!member?.isActive || member.id === "global-operator") return null;
    const role = await capturePermissionEpochs(tx, workspaceId, [{kind: "MemberRolePolicy", id: member.id}]);
    return mergePermissionEpochProofs(ambient, role)!;
  });
  if (!caller) return null;
  const proof: LineageRoot[] = [];
  for (const row of rows) {
    const original = parsePermissionEpochProof(latest.get(row.id)?.permissionEpochsJson);
    if (!original) return null;
    try {proof.push({kind: "KnowledgeChunk", id: row.id, fingerprint: lineageContentFingerprint("KnowledgeChunk", row),
      permissionEpochs: mergePermissionEpochProofs(original, caller)!});} catch {return null;}
  }
  for (const input of native) {
    const original = parsePermissionEpochProof(input.permissionEpochsJson);
    if (!original) return null;
    try {proof.push({kind: "SqlNativeRunInput", id: input.id, fingerprint: lineageContentFingerprint("SqlNativeRunInput", input),
      permissionEpochs: mergePermissionEpochProofs(original, caller)!});} catch {return null;}
  }
  return proof;
}

/** Fixed read-only SQL collection executor. Undefined selects the general mixed
 * lineage/MCP/agent executor. This issues no caller, source or commit capability.
 * It checks the complete candidate set, never only the displayed citations. */
export async function isSqlKnowledgeInputProofReadable(actor: AppActor, workspaceId: string,
  roots: readonly LineageRoot[]): Promise<boolean | undefined> {
  if (actor.kind !== "user" || getMcpOrigin() || isArtifactNativeCommitPhase() || !roots.length
    || roots.some(root => !["KnowledgeChunk", "SqlNativeRunInput"].includes(root.kind))) return undefined;
  const children = roots.filter(root => root.kind === "KnowledgeChunk");
  if (!children.length || children.length > 5000) return undefined;
  const ids = [...new Set(children.map(root => root.id))];
  const firstRows = await prisma.knowledgeChunk.findMany({where: {workspaceId, id: {in: ids}},
    select: {sourceType: true, metadata: true}});
  if (firstRows.some(row => row.sourceType !== "EXTERNAL_DATABASE")) return undefined;
  if (firstRows.length !== ids.length) return false;
  let union;
  try {
    const proofs = roots.map(root => parsePermissionEpochProof(root.permissionEpochs));
    if (proofs.some(proof => !proof)) return false;
    union = mergePermissionEpochProofs(...proofs.filter(proof => proof !== null));
  } catch {return false;}
  // Cache/native worker proofs cannot replace the consumption-time principal.
  if (!union?.entries.some(entry => entry.kind === "MemberUserPolicy" && entry.id === actor.user.id)
    || !union.entries.some(entry => entry.kind === "WorkspaceSupportPolicy" && entry.id === actor.user.id)) return false;
  const nativeIds = [...new Set(firstRows.map(row => (row.metadata as Record<string, unknown> | null)?.nativeInputId))];
  if (nativeIds.some(id => typeof id !== "string" || !id)) return false;
  const native = await loadSqlNativeRunInputs(workspaceId, nativeIds as string[]);
  if (native.length !== nativeIds.length) return false;
  const nativeById = new Map(native.map(row => [row.id, row]));
  const nativeStamp = new Map(native.map(row => [row.id, lineageContentFingerprint("SqlNativeRunInput", row)]));
  for (const root of roots.filter(root => root.kind === "SqlNativeRunInput")) {
    if (nativeStamp.get(root.id) !== root.fingerprint) return false;
  }
  const publicationIds = firstRows.map(row => (row.metadata as Record<string, unknown>).sqlPublicationId);
  if (publicationIds.some(id => typeof id !== "string" || !id)) return false;
  // Entry and exit reload actual rows, latest manifests, and staged membership.
  // Every manifest stamp is retained across native awaits, including same-body
  // ancestry changes. Local permission changes cannot introduce an unreplayed leaf.
  const local = async (originals: readonly SqlNativeRunInput[]) => {
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, union, prisma)) return null;
    const [rows, manifests, staged, publications, nativeUnchanged] = await Promise.all([
      prisma.knowledgeChunk.findMany({where: {workspaceId, id: {in: ids}}}),
      prisma.artifactInputLineage.findMany({where: {workspaceId, artifactType: "KnowledgeChunk", artifactId: {in: ids}}, orderBy: {revision: "desc"}}),
      loadSqlKnowledgeStages(ids),
      prisma.sqlKnowledgePublication.findMany({where: {workspaceId, id: {in: publicationIds as string[]}, status: "COMMITTED", committedAt: {not: null}}}),
      areSqlNativeRunInputsUnchanged(workspaceId, originals),
    ]);
    if (rows.length !== ids.length || staged.length !== ids.length || !nativeUnchanged) return null;
    const byId = new Map(rows.map(row => [row.id, row])), stages = new Map(staged.map(row => [row.id, row]));
    const pubs = new Map(publications.map(row => [row.id, row]));
    const latest = new Map<string, typeof manifests[number]>();
    for (const manifest of manifests) if (!latest.has(manifest.artifactId)) latest.set(manifest.artifactId, manifest);
    for (const root of children) {
      const row = byId.get(root.id)!, manifest = latest.get(root.id), stage = stages.get(root.id);
      const metadata = row.metadata as Record<string, unknown> | null;
      const source = metadata && nativeById.get(String(metadata.nativeInputId));
      const pub = metadata && pubs.get(String(metadata.sqlPublicationId));
      if (row.sourceType !== "EXTERNAL_DATABASE" || lineageContentFingerprint("KnowledgeChunk", row) !== root.fingerprint
        || !metadata || !source || !pub || pub.nativeInputId !== source.id || pub.sourceId !== source.sourceId
        || pub.attemptId !== source.attemptId || pub.generation !== source.generation
        || pub.configurationFingerprint !== source.configurationFingerprint || !stage || stage.publicationId !== pub.id
        || stage.contentHash !== root.fingerprint || lineageContentFingerprint("KnowledgeChunk", stage.contentJson) !== root.fingerprint
        || metadata.sourceContentHash !== nativeStamp.get(source.id) || !manifest || manifest.origin !== "DERIVED"
        || manifest.contentHash !== root.fingerprint || manifest.epochProofVersion !== 1
        || !isDeepStrictEqual(manifest.inputsJson, [{kind: "SqlNativeRunInput", id: source.id}])
        || !Array.isArray(manifest.rootsJson)
        || !isPublishedSqlKnowledgeVector(row.id, row as unknown as Record<string, unknown>,
          manifest.rootsJson as unknown as LineageRoot[], manifest.permissionEpochsJson, source.permissionEpochsJson)) return null;
    }
    // Submitted roots cannot omit a persisted child's original own epoch or
    // native contributor. Check the actual complete source+child union too.
    let persistedUnion;
    try {
      const childProofs = ids.map(id => parsePermissionEpochProof(latest.get(id)!.permissionEpochsJson));
      const sourceProofs = originals.map(input => parsePermissionEpochProof(input.permissionEpochsJson));
      if ([...childProofs, ...sourceProofs].some(proof => !proof)) return null;
      persistedUnion = mergePermissionEpochProofs(union, ...[...childProofs, ...sourceProofs].filter(proof => proof !== null));
    } catch {return null;}
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, persistedUnion, prisma)) return null;
    for (const input of originals) if (!await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input)) return null;
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, union, prisma)) return null;
    // Keep complete observation identity, not the semantic content fingerprint:
    // timestamps, original manifests, staging ordinals and all vector bytes must
    // also match after the native await. These stamps are request-local: both
    // observations use the same stage transport/key order; no persisted digest
    // or native fingerprint changes. Serialize one tuple at a time so neither
    // the entry ledger nor the exit ledger retains vector-bearing ORM objects.
    return ids.map(id => createHash("sha256").update(serialize([
      byId.get(id), latest.get(id), stages.get(id),
    ])).digest("hex"));
  };
  const before = await local(native);
  if (!before) return false;
  for (const input of native) if (!await isSqlNativeRunInputCurrent(actor, workspaceId, input)) return false;
  const after = await local(native);
  return Boolean(after && isDeepStrictEqual(before, after));
}
