import type { Prisma } from "@prisma/client";
import { artifactPermissionParents, loadArtifactPermissionMetadata } from "./source-permission-parents";
import { artifactPermissionEpochIdentities, isArtifactPermissionEpochProofCurrent,
  mergePermissionEpochProofs, parsePermissionEpochProof } from "./source-permission-epochs";
import { inspectStoredArtifactInputDependencies, lineageContentFingerprint,
  type LineageInput, type LineageKind, type LineageRoot } from "./source-lineage";

type SavedPreimage = { input: LineageInput; row: Record<string, unknown>; snapshotId: string };
const inputKey = (input: LineageInput) => JSON.stringify([input.kind, input.id]);
const revisionKey = (input: LineageRoot) => JSON.stringify([input.kind, input.id, input.fingerprint]);

/** Check consumed history without minting a permission revision. A current H0
 * creation manifest cannot supply a missing earlier consumption epoch. */
export async function isArtifactInputPermissionEpochCoverageComplete(params: {
  workspaceId: string;
  artifact: LineageInput;
  /** Recorded preimage, when the live body has already changed. */
  content?: Record<string, unknown>;
  roots: readonly LineageRoot[];
  permissionEpochs: unknown;
  db: Prisma.TransactionClient;
}): Promise<boolean> {
  const { workspaceId, artifact, roots, db } = params;
  const own = parsePermissionEpochProof(params.permissionEpochs);
  if (!own) return false;
  const dependencies = await inspectStoredArtifactInputDependencies(db, workspaceId, roots, { maxNodes: 10000 });
  if (!dependencies.complete) return false;
  const proofs = [own];
  // Discovery may cross a mutable same-body manifest appended AFTER the actual
  // consumption. Such edges enumerate required governors but cannot contribute
  // proof material. Only submitted roots and hash-bound immutable ancestry can.
  const evidence = [...roots], evidenceKeys = new Set<string>();
  const preimagesByRevision = new Map<string, SavedPreimage[]>();
  const preimagesByIdentity = new Map<string, SavedPreimage[]>();
  for (let index = 0; index < evidence.length; index++) {
    const root = evidence[index], key = JSON.stringify([root.kind, root.id, root.fingerprint]);
    if (evidenceKeys.has(key)) continue;
    if (evidenceKeys.size >= 10000) return false;
    evidenceKeys.add(key);
    if (root.permissionEpochs !== undefined) {
      const saved = parsePermissionEpochProof(root.permissionEpochs);
      if (!saved) return false;
      proofs.push(saved);
    }
    if (root.kind === "ArtifactInputSnapshot") {
      const snapshot = await db.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId },
      });
      const saved = snapshot?.epochProofVersion === 1 ? parsePermissionEpochProof(snapshot.permissionEpochsJson) : null;
      if (!saved || lineageContentFingerprint("ArtifactInputSnapshot", snapshot) !== root.fingerprint
        || !Array.isArray(snapshot!.rootsJson) || !snapshot!.contentJson
        || typeof snapshot!.contentJson !== "object" || Array.isArray(snapshot!.contentJson)
        || !snapshot!.accessEnvelopeJson || typeof snapshot!.accessEnvelopeJson !== "object"
        || Array.isArray(snapshot!.accessEnvelopeJson) || typeof snapshot!.sourceKind !== "string"
        || typeof snapshot!.sourceId !== "string" || !snapshot!.sourceId) return false;
      const source = { kind: snapshot!.sourceKind as LineageKind, id: snapshot!.sourceId,
        fingerprint: snapshot!.sourceFingerprint };
      try {
        if (lineageContentFingerprint(source.kind, snapshot!.contentJson) !== source.fingerprint) return false;
      } catch { return false; }
      const preimage: SavedPreimage = { input: source,
        row: { ...snapshot!.contentJson as Record<string, unknown>,
          ...snapshot!.accessEnvelopeJson as Record<string, unknown>, id: source.id },
        snapshotId: root.id };
      const byRevision = revisionKey(source), byIdentity = inputKey(source);
      preimagesByRevision.set(byRevision, [...(preimagesByRevision.get(byRevision) ?? []), preimage]);
      preimagesByIdentity.set(byIdentity, [...(preimagesByIdentity.get(byIdentity) ?? []), preimage]);
      proofs.push(saved);
      for (const input of snapshot!.rootsJson) {
        if (!input || typeof input !== "object" || Array.isArray(input)
          || typeof input.kind !== "string" || typeof input.id !== "string"
          || typeof input.fingerprint !== "string") return false;
        evidence.push(input as unknown as LineageRoot);
      }
    }
  }
  let union;
  try { union = mergePermissionEpochProofs(...proofs); } catch { return false; }
  if (!union) return false;
  const savedKeys = new Set(union.entries.map(entry => JSON.stringify([entry.kind, entry.id])));
  type Pending = { input: LineageInput; row?: Record<string, unknown>; key: string };
  const pending: Pending[] = [{ input: artifact, row: params.content,
    key: `head:${inputKey(artifact)}` }];
  const queue = (input: LineageInput, fingerprint?: string): boolean => {
    const saved = fingerprint
      ? preimagesByRevision.get(JSON.stringify([input.kind, input.id, fingerprint]))
      : preimagesByIdentity.get(inputKey(input));
    if (saved?.length) {
      for (const preimage of saved) pending.push({ input: preimage.input, row: preimage.row,
        key: `snapshot:${preimage.snapshotId}` });
    } else pending.push({ input, key: `live:${inputKey(input)}` });
    return pending.length <= 10000;
  };
  for (const root of dependencies.roots) if (!queue(root, root.fingerprint)) return false;
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const { input, row: savedRow, key } = pending[index];
    if (visited.has(key)) continue;
    if (visited.size >= 10000) return false;
    visited.add(key);
    const row = savedRow ?? await loadArtifactPermissionMetadata(db, workspaceId, input);
    if (!row) return false;
    // A snapshot's saved vector describes the original source, whose live
    // envelope is discovered separately. The immutable receipt ID is no grant.
    const required = artifactPermissionEpochIdentities(input.kind, { ...row, id: input.id, workspaceId })
      .filter(identity => input.kind !== "ArtifactInputSnapshot" || identity.kind !== input.kind || identity.id !== input.id);
    if (!required.every(identity => savedKeys.has(JSON.stringify([identity.kind, identity.id])))) return false;
    for (const parent of artifactPermissionParents(input.kind, row)) if (!queue(parent)) return false;
    if (input.kind === "FinanceImportBatch") {
      // Match the constructor's reverse native-input edge. This current lookup
      // enumerates required identity only; it contributes no fresh proof.
      const upload = await db.financeReportUploadInput.findFirst({ where: { workspaceId, batchId: input.id },
        select: { id: true } });
      if (!upload) return false;
      if (!queue({ kind: "FinanceReportUploadInput", id: upload.id })) return false;
    }
  }
  return isArtifactPermissionEpochProofCurrent(workspaceId, union, db);
}
