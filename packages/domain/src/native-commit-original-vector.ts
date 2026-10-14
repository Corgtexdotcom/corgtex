import { prisma } from "@corgtex/shared";
import type { LineageRoot } from "./source-lineage";
import { parsePermissionEpochProof, type PermissionEpochProof } from "./source-permission-epochs";
import { invariant } from "./errors";

const key = (kind: string, id: string, fingerprint: string) => JSON.stringify([kind, id, fingerprint]);

/** Recover only a saved DERIVED ancestor's actual native input vector. Callers
 * must first admit the complete submitted closure, then still check this
 * vector and the native bytes/grant live. This never captures fresh epochs. */
export async function savedEnclosingNativeEpochs(workspaceId: string, submitted: readonly LineageRoot[],
  nativeKind: string): Promise<Map<string, PermissionEpochProof>> {
  const result = new Map<string, PermissionEpochProof>();
  const ancestors = submitted.filter(root => root.kind !== nativeKind);
  invariant(ancestors.length <= 10000, 409, "SOURCE_CHANGED", "Native ancestor proof exceeds the scan limit.");
  for (const root of ancestors) {
    const manifest = await prisma.artifactInputLineage.findFirst({ where: { workspaceId,
      artifactType: root.kind, artifactId: root.id },
    orderBy: { revision: "desc" } });
    const proof = manifest?.origin === "DERIVED" && manifest.contentHash === root.fingerprint
      && manifest.epochProofVersion === 1 ? parsePermissionEpochProof(manifest.permissionEpochsJson) : null;
    if (!proof || !Array.isArray(manifest?.rootsJson)) continue;
    for (const value of manifest.rootsJson) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const input = value as Record<string, unknown>;
      if (input.kind !== nativeKind || typeof input.id !== "string" || typeof input.fingerprint !== "string"
        || !proof.entries.some(entry => entry.kind === nativeKind && entry.id === input.id)) continue;
      result.set(key(nativeKind, input.id, input.fingerprint), proof);
    }
  }
  return result;
}

export const savedNativeVectorKey = key;
