import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { captureArtifactInputProof, captureArtifactReadHeadObservation, mergeLineageInputRoot, withArtifactCountReleaseSnapshot, isArtifactInputProofReadable, type LineageInput, type LineageKind, type LineageRoot } from "./source-lineage";
import { mergePermissionEpochProofs } from "./source-permission-epochs";

/** One request's original compact observations, released together in a fresh snapshot. */
export class DigestReadRelease {
  private readonly roots = new Map<string, LineageRoot>();
  private readonly heads = new Map<string, string>();
  constructor(readonly actor: AppActor, readonly workspaceId: string) {}
  add(proof: readonly LineageRoot[]) {
    for (const root of proof) {
      const key = `${root.kind}:${root.id}`;
      this.roots.set(key, mergeLineageInputRoot(this.roots.get(key), root));
    }
  }
  async observeRead<T>(read: () => Promise<T>): Promise<T> {
    const observed = await captureArtifactReadHeadObservation(read);
    for (const [key, stamp] of observed.heads) {
      invariant(!this.heads.has(key) || this.heads.get(key) === stamp, 409, "SOURCE_CHANGED", "Source lineage changed during collection.");
      this.heads.set(key, stamp);
    }
    return observed.value;
  }
  async capture<T extends {id: string}>(kind: LineageKind, records: T[]) {
    const captured = await this.observeRead(() => captureReadableDigestInputs({actor: this.actor, workspaceId: this.workspaceId, kind, records}));
    this.add(captured.roots);
    return captured;
  }
  finish<T>(value: T) {
    return withArtifactCountReleaseSnapshot(this.actor, this.workspaceId, [...this.roots.values()], async () => {}, async tx => {
      await requireWorkspaceMembership({actor: this.actor, workspaceId: this.workspaceId, tx});
      return value;
    }, this.heads);
  }
}

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
  release?: DigestReadRelease;
}) {
  const records: T[] = [];
  const release = params.release ?? (params.completeScan ? new DigestReadRelease(params.actor, params.workspaceId) : undefined);
  const take = Math.min(100, Math.max(50, params.limit));
  const scanLimit = 5_000;
  let skip = 0;
  let after: T | undefined;
  const seen = new Set<string>();
  const candidates = new Set<string>();
  while (params.completeScan || records.length < params.limit) {
    const page = params.keyset ? { skip: 0, after } : { skip };
    if (!params.completeScan && skip >= scanLimit) {
      // An exact-budget history still needs an empty terminator query.
      const more = await params.loadBatch({ take: 1, ...page });
      invariant(more.length === 0, 503, "INPUT_SCAN_LIMIT", "Input collection needs a lineage rebuild before it can complete.");
      break;
    }
    const batch = await params.loadBatch({ take, ...page });
    for (const row of batch) {
      invariant(!candidates.has(row.id), 409, "SOURCE_CHANGED", "Input collection changed during pagination.");
      candidates.add(row.id);
    }
    const captured = release
      ? await release.observeRead(() => captureReadableDigestInputs({ ...params, records: batch }))
      : await captureReadableDigestInputs({ ...params, records: batch });
    const fresh = captured.records.filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    });
    const selected = params.completeScan ? fresh : fresh.slice(0, params.limit - records.length);
    for (const row of selected) release?.add(captured.proofs.get(row.id) ?? []);
    records.push(...selected);
    if (batch.length < take) break;
    skip += batch.length;
    after = batch.at(-1);
  }
  return release && !params.release ? release.finish(records) : records;
}
