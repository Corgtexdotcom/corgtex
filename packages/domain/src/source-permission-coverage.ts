import type { Prisma } from "@prisma/client";
import { artifactPermissionParents, loadArtifactPermissionMetadata } from "./source-permission-parents";
import { artifactPermissionEpochIdentities, isArtifactPermissionEpochProofCurrent,
  mergePermissionEpochProofs, parsePermissionEpochProof } from "./source-permission-epochs";
import { inspectStoredArtifactInputDependencies, lineageContentFingerprint,
  type LineageInput, type LineageRoot } from "./source-lineage";

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
        || !Array.isArray(snapshot!.rootsJson)) return false;
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
  const pending: LineageInput[] = [artifact, ...dependencies.roots];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const input = pending[index], key = JSON.stringify([input.kind, input.id]);
    if (visited.has(key)) continue;
    if (visited.size >= 10000) return false;
    visited.add(key);
    const row = key === JSON.stringify([artifact.kind, artifact.id]) && params.content
      ? params.content : await loadArtifactPermissionMetadata(db, workspaceId, input);
    if (!row) return false;
    // A snapshot's saved vector describes the original source, whose live
    // envelope is discovered separately. The immutable receipt ID is no grant.
    const required = artifactPermissionEpochIdentities(input.kind, { ...row, id: input.id, workspaceId })
      .filter(identity => input.kind !== "ArtifactInputSnapshot" || identity.kind !== input.kind || identity.id !== input.id);
    if (!required.every(identity => savedKeys.has(JSON.stringify([identity.kind, identity.id])))) return false;
    pending.push(...artifactPermissionParents(input.kind, row));
    if (input.kind === "FinanceImportBatch") {
      // Match the constructor's reverse native-input edge. This current lookup
      // enumerates required identity only; it contributes no fresh proof.
      const upload = await db.financeReportUploadInput.findFirst({ where: { workspaceId, batchId: input.id },
        select: { id: true } });
      if (!upload) return false;
      pending.push({ kind: "FinanceReportUploadInput", id: upload.id });
    }
  }
  return isArtifactPermissionEpochProofCurrent(workspaceId, union, db);
}
