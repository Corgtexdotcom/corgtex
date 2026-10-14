import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { captureArtifactInputProof, isArtifactInputProofReadable, type LineageInput, type LineageKind, type LineageRoot } from "./source-lineage";
import { mergePermissionEpochProofs } from "./source-permission-epochs";

export function mergeArtifactInputProofs(...proofs: ReadonlyArray<readonly LineageRoot[]>): LineageRoot[] {
  const roots = new Map<string, LineageRoot>();
  for (const proof of proofs) for (const root of proof) {
    const key = `${root.kind}:${root.id}`;
    const previous = roots.get(key);
    invariant(!previous || previous.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Digest inputs changed during collection.");
    const permissionEpochs = mergePermissionEpochProofs(previous?.permissionEpochs, root.permissionEpochs);
    roots.set(key, permissionEpochs ? { ...root, permissionEpochs } : root);
  }
  return [...roots.values()];
}

export async function isDigestInputProofShared(audience: readonly AppActor[], workspaceId: string, roots: readonly LineageRoot[]) {
  const permissions = await Promise.all(audience.map(async (actor) => {
    try { return await isArtifactInputProofReadable(actor, workspaceId, roots); }
    catch (error) {
      // A departed recipient is removed from the audience; its stale identity
      // must not block generation for the remaining active members.
      if (error instanceof AppError && error.code === "NOT_A_MEMBER") return true;
      throw error;
    }
  }));
  return permissions.every(Boolean);
}

/** Unknown legacy entries are omitted individually before formatting, ranking or counting. */
export async function captureReadableDigestInputs<T extends { id: string }>(params: {
  actor: AppActor;
  workspaceId: string;
  kind: LineageKind;
  records: T[];
  audience?: AppActor[];
  additionalInputs?: (record: T) => Array<LineageInput & { snapshot?: Record<string, unknown> }>;
}) {
  const records: T[] = [];
  const proofs = new Map<string, LineageRoot[]>();
  for (const record of params.records) {
    try {
      const roots = await captureArtifactInputProof(params.actor, params.workspaceId, [
        { kind: params.kind, id: record.id, snapshot: record },
        ...(params.additionalInputs?.(record) ?? []),
      ]);
      if (params.audience && !await isDigestInputProofShared(params.audience, params.workspaceId, roots)) continue;
      records.push(record);
      proofs.set(record.id, roots);
    } catch (error) {
      if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
    }
  }
  return { records, proofs, roots: mergeArtifactInputProofs(...proofs.values()) };
}

/** Apply the editorial sample size to permitted records, with bounded database batches. */
export async function loadReadableDigestQuery<T extends { id: string }>(params: {
  actor: AppActor;
  audience?: AppActor[];
  workspaceId: string;
  kind: LineageKind;
  limit: number;
  loadBatch: (page: { take: number; skip: number; after?: NoInfer<T> }) => Promise<T[]>;
  completeScan?: boolean;
  keyset?: boolean;
}) {
  const records: T[] = [];
  const take = Math.min(100, Math.max(50, params.limit));
  const scanLimit = 5_000;
  let skip = 0;
  let after: T | undefined;
  const seen = new Set<string>();
  while (params.completeScan || records.length < params.limit) {
    const page = params.keyset ? { skip: 0, after } : { skip };
    if (skip >= scanLimit) {
      // An exact-budget history still needs an empty terminator query.
      const more = await params.loadBatch({ take: 1, ...page });
      invariant(more.length === 0, 503, "INPUT_SCAN_LIMIT", "Input collection needs a lineage rebuild before it can complete.");
      break;
    }
    const batch = await params.loadBatch({ take, ...page });
    const captured = await captureReadableDigestInputs({ ...params, records: batch });
    const fresh = captured.records.filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    });
    records.push(...(params.completeScan ? fresh : fresh.slice(0, params.limit - records.length)));
    if (batch.length < take) break;
    skip += batch.length;
    after = batch.at(-1);
  }
  return records;
}
