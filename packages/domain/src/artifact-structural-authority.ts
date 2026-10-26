import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { prisma, type AppActor } from "@corgtex/shared";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import { assertOutsideArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { invariant } from "./errors";
import { inspectArtifactStructuralVariantTarget,
  type LineageInput } from "./source-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  type PermissionEpochIdentity, type PermissionEpochProof } from "./source-permission-epochs";
import type { SourceCommitOwnerBinding } from "./source-commit-lock-plan";
import { discoverSourceAuthorityEdges, loadSourceAuthorityRecord } from "./source-authority-edges";

declare const structuralBrand: unique symbol;
export type ArtifactStructuralAuthority = { readonly [structuralBrand]: true };
export type ArtifactStructuralAuthorityBinding = {
  purpose: "NEW_OWNER_PRIVATE_VARIANT";
  ownerBinding: SourceCommitOwnerBinding;
};
type Observation = Awaited<ReturnType<typeof inspectArtifactStructuralVariantTarget>>;
type State = { actor: AppActor; actorHash: string; workspaceId: string; target: LineageInput;
  origin: unknown; binding: ArtifactStructuralAuthorityBinding; observation: Observation;
  permissionEpochs: PermissionEpochProof };
const receipts = new WeakMap<object, State>();
const hashActor = (actor: AppActor) => createHash("sha256").update(JSON.stringify(actor)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Walk governing links only. Historical manifests, model inputs and stored
 * source vectors cannot be refreshed by this deliberately narrow constructor. */
async function structuralGovernorIdentities(actor: AppActor, workspaceId: string,
  target: LineageInput, ownerMemberId: string): Promise<PermissionEpochIdentity[]> {
  const identities: PermissionEpochIdentity[] = [{ kind: "Workspace", id: workspaceId }];
  const pending: LineageInput[] = [target, { kind: "Member", id: ownerMemberId }];
  const visited = new Set<string>(), budgetKeys = new Set<string>();
  const budget = {
    consume(key: string) {
      if (budgetKeys.has(key)) return;
      invariant(budgetKeys.size < 10000, 409, "SOURCE_LOCK_LIMIT", "Structural authority requires a bounded rebuild.");
      budgetKeys.add(key);
    },
    remaining: () => Math.max(0, 10000 - budgetKeys.size),
  };
  const context = { actor, workspaceId, db: prisma, budget };
  for (let index = 0; index < pending.length; index++) {
    const input = pending[index], key = JSON.stringify([input.kind, input.id]);
    if (visited.has(key)) continue;
    visited.add(key); budget.consume(`structural:${key}`);
    const record = await loadSourceAuthorityRecord(prisma, workspaceId, input);
    invariant(record, 409, "SOURCE_CHANGED", "A structural governor is unavailable.");
    const edges = await discoverSourceAuthorityEdges(context, input, record);
    invariant(!edges.consumedArtifacts?.length, 409, "SOURCE_LOCK_UNSUPPORTED",
      "Structural authority cannot refresh consumed input ancestry.");
    identities.push(...edges.policies);
    pending.push(...edges.artifacts);
  }
  return [...new Map(identities.map(identity => [JSON.stringify([identity.kind, identity.id]), identity])).values()];
}

/** Fresh authority for target STRUCTURE only. Never exposes or re-admits an old
 * target body, never returns a vector/root to a model or read collector. */
export async function prepareArtifactStructuralAuthority(actor: AppActor, workspaceId: string,
  submittedTarget: LineageInput, submittedBinding: ArtifactStructuralAuthorityBinding): Promise<ArtifactStructuralAuthority> {
  assertOutsideArtifactNativeCommitPhase();
  sealArtifactInputActor(actor);
  const target = freeze(structuredClone(submittedTarget));
  const binding = freeze(structuredClone(submittedBinding));
  const origin = freeze(structuredClone(getMcpOrigin() ?? null));
  const actorHash = hashActor(actor);
  invariant(binding.purpose === "NEW_OWNER_PRIVATE_VARIANT" && typeof binding.ownerBinding?.id === "string"
    && Number.isSafeInteger(binding.ownerBinding.generation) && binding.ownerBinding.generation > 0,
  409, "SOURCE_RESTRICTED", "Structural authority requires an exact variant owner.");
  const observation = await inspectArtifactStructuralVariantTarget(actor, workspaceId, target);
  const identities = await structuralGovernorIdentities(actor, workspaceId, target, observation.ownerMemberId);
  const permissionEpochs = await prisma.$transaction(tx => capturePermissionEpochs(tx, workspaceId, identities));
  invariant(actorHash === hashActor(actor) && isDeepStrictEqual(origin, getMcpOrigin() ?? null)
    && isDeepStrictEqual(observation, await inspectArtifactStructuralVariantTarget(actor, workspaceId, target))
    && await isArtifactPermissionEpochProofCurrent(workspaceId, permissionEpochs),
  409, "SOURCE_CHANGED", "Structural target changed while preparing its authority.");
  const token = Object.freeze({}) as ArtifactStructuralAuthority;
  receipts.set(token, { actor, actorHash, workspaceId, target, origin, binding,
    observation: freeze(observation), permissionEpochs: freeze(permissionEpochs) });
  return token;
}

/** Internal plan constructor seam. Consumed vectors stay separate from these
 * current structural fences; this token cannot authorize a canonical mutation. */
export function consumeArtifactStructuralAuthority(actor: AppActor, workspaceId: string,
  ownerBinding: SourceCommitOwnerBinding, token: ArtifactStructuralAuthority) {
  const state = receipts.get(token);
  invariant(state && state.actor === actor && state.actorHash === hashActor(actor) && state.workspaceId === workspaceId
    && isDeepStrictEqual(state.origin, getMcpOrigin() ?? null) && isDeepStrictEqual(state.binding.ownerBinding, ownerBinding),
  409, "SOURCE_CHANGED", "Structural authority does not match its current owner.");
  receipts.delete(token);
  return state;
}
