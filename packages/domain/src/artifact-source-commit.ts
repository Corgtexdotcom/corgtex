import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight,
  type ArtifactCommitPreflight } from "./artifact-commit-preflight";
import { prepareSourceCommitAmbientFences, prepareSourceCommitLockPlan, prepareSourceCommitOwnerAttestation, withSourceCommitLockPlan,
  type SourceCommitControlWriteTarget, type SourceCommitLockPlan, type SourceCommitOwnerBinding, type SourceCommitWriteTarget } from "./source-commit-lock-plan";
import type { LineageRoot } from "./source-lineage";
import type { ArtifactStructuralAuthority } from "./artifact-structural-authority";

declare const sourceCommitBrand: unique symbol;
/** Exact, single-use preparation for the source plan AND its native executor. */
export type ArtifactSourceCommit = { readonly [sourceCommitBrand]: true };
export type ArtifactSourceCommitOptions = {
  writeTargets: readonly SourceCommitWriteTarget[];
  ownerBinding: SourceCommitOwnerBinding;
  structuralAuthorities?: readonly ArtifactStructuralAuthority[];
  controlWriteTargets?: readonly SourceCommitControlWriteTarget[];
};
type Prepared = { actor: AppActor; workspaceId: string; roots: LineageRoot[];
  controls: SourceCommitControlWriteTarget[]; targets: SourceCommitWriteTarget[]; binding: SourceCommitOwnerBinding;
  structural: readonly ArtifactStructuralAuthority[];
  source: SourceCommitLockPlan; native: ArtifactCommitPreflight };
const prepared = new WeakMap<object, Prepared>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** All native replay and metadata discovery finish before the caller opens SQL.
 * This does not attest a durable worker claim or grant source read authority. */
export async function prepareArtifactSourceCommit(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[], options: ArtifactSourceCommitOptions): Promise<ArtifactSourceCommit> {
  const roots = freeze(structuredClone([...originalRoots]));
  const targets = freeze(structuredClone([...options.writeTargets]));
  const controls = freeze(structuredClone([...(options.controlWriteTargets ?? [])]));
  const binding = freeze(structuredClone(options.ownerBinding));
  // Opaque capabilities must retain identity; cloning turns them into forgeries.
  const structural = Object.freeze([...(options.structuralAuthorities ?? [])]);
  const native = await prepareArtifactCommitPreflight(actor, workspaceId, roots);
  await prepareSourceCommitAmbientFences(actor, workspaceId);
  const source = await prepareSourceCommitLockPlan(actor, workspaceId, roots,
    { writeTargets: targets, ...(controls.length ? { controlWriteTargets: controls } : {}), ownerBinding: binding,
      ...(structural.length ? { structuralAuthorities: structural } : {}) });
  const token = Object.freeze({}) as ArtifactSourceCommit;
  prepared.set(token, { actor, workspaceId, roots, targets, controls, binding, structural, source, native });
  return token;
}

/** Trusted lifecycle adapters must query/lock their real ownership controls in
 * assertOwner. A JSON owner tuple or callback alone is not that authorization.
 * Source coverage stays active through the safe native executor and DB writer. */
export async function withArtifactSourceCommit<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, originalRoots: readonly LineageRoot[], options: ArtifactSourceCommitOptions,
  token: ArtifactSourceCommit,
  assertOwner: (tx: Prisma.TransactionClient, binding: SourceCommitOwnerBinding) => Promise<void>,
  work: () => Promise<T>): Promise<T> {
  const state = prepared.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma
    && isDeepStrictEqual(state.roots, originalRoots) && isDeepStrictEqual(state.targets, options.writeTargets)
    && isDeepStrictEqual(state.controls, options.controlWriteTargets ?? [])
    && state.structural.length === (options.structuralAuthorities?.length ?? 0)
    && state.structural.every((receipt, index) => receipt === options.structuralAuthorities![index])
    && isDeepStrictEqual(state.binding, options.ownerBinding),
  409, "SOURCE_CHANGED", "Source commit preparation does not match its immutable caller and inputs.");
  // Burn before the first await; a failed/rejected writer needs new preparation.
  prepared.delete(token);
  return withArtifactNativeCommitPhase(async () => {
    const owner = await prepareSourceCommitOwnerAttestation(actor, workspaceId, tx,
      state.source, state.binding, assertOwner);
    return withSourceCommitLockPlan(actor, workspaceId, tx, state.roots, state.targets,
      state.binding, state.source, owner,
      () => withArtifactCommitPreflight(actor, workspaceId, tx, state.roots, state.native, work));
  });
}
