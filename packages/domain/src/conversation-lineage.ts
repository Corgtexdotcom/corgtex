import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { mergePermissionEpochProofs } from "./source-permission-epochs";
import {
  captureArtifactInputProof,
  isArtifactInputProofReadable,
  rebaseArtifactInputProofToSnapshots,
  type LineageInput,
  type LineageRoot,
} from "./source-lineage";

/** A live, server-created receipt. JSON or model-supplied receipt lookalikes are not accepted. */
export type ConversationInputReceipt = Readonly<{
  type: "conversation-input-receipt";
  payloadHash: string;
}>;

export type ConversationInputFragment = {
  value: unknown;
  receipt: ConversationInputReceipt;
};

type ReceiptState = {
  actorScope: string;
  workspaceId: string;
  payloadHash: string;
  roots: LineageRoot[];
};

const receipts = new WeakMap<ConversationInputReceipt, ReceiptState>();

function actorScope(actor: AppActor) {
  return actor.kind === "user" ? `user:${actor.user.id}` : JSON.stringify({
    kind: actor.kind,
    authProvider: actor.authProvider,
    credentialId: actor.credentialId,
    credentialVersion: actor.credentialVersion,
    agentIdentityId: actor.agentIdentityId,
    workspaceIds: [...(actor.workspaceIds ?? [])].sort(),
    scopes: [...(actor.scopes ?? [])].sort(),
    supportOrigin: actor.supportOrigin,
  });
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJson(item)]));
  }
  return value;
}

function payloadHash(value: unknown) {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { invariant(false, 400, "INVALID_INPUT_RECEIPT", "Conversation input must be serializable."); }
  invariant(encoded !== undefined, 400, "INVALID_INPUT_RECEIPT", "Conversation input must be serializable.");
  return createHash("sha256").update(JSON.stringify(sortedJson(JSON.parse(encoded)))).digest("hex");
}

function mergeRoots(proofs: readonly LineageRoot[][]) {
  const merged = new Map<string, LineageRoot>();
  for (const proof of proofs) for (const root of proof) {
    const key = `${root.kind}:${root.id}`;
    const earlier = merged.get(key);
    invariant(!earlier || earlier.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Conversation inputs changed during collection.");
    const permissionEpochs = mergePermissionEpochProofs(earlier?.permissionEpochs, root.permissionEpochs);
    merged.set(key, permissionEpochs ? { ...root, permissionEpochs } : { ...root });
  }
  return [...merged.values()];
}

function checkedState(params: { actor: AppActor; workspaceId: string; value: unknown; receipt: ConversationInputReceipt }) {
  const state = receipts.get(params.receipt);
  invariant(state && state.actorScope === actorScope(params.actor) && state.workspaceId === params.workspaceId,
    409, "INVALID_INPUT_RECEIPT", "Conversation receipt does not belong to this request.");
  invariant(state.payloadHash === payloadHash(params.value), 409, "SOURCE_CHANGED", "Conversation input changed after capture.");
  return state;
}

/** Call before supplying this exact value to the model, using every source its producer consumed. */
export async function captureConversationInputReceipt(params: {
  actor: AppActor;
  workspaceId: string;
  value: unknown;
  inputs?: Array<LineageInput & { snapshot?: Record<string, unknown> }>;
  /** Only trusted in-process producers may attach their pre-generation proof. */
  trustedRoots?: readonly LineageRoot[];
  db?: Prisma.TransactionClient;
}): Promise<ConversationInputReceipt> {
  const hash = payloadHash(params.value);
  const roots = mergeRoots([
    params.inputs?.length ? await captureArtifactInputProof(params.actor, params.workspaceId, params.inputs, params.db) : [],
    [...(params.trustedRoots ?? [])],
  ]);
  invariant(roots.length > 0, 409, "UNKNOWN_LINEAGE", "Conversation input has no complete source proof.");
  invariant(await isArtifactInputProofReadable(params.actor, params.workspaceId, roots, params.db),
    409, "SOURCE_CHANGED", "Conversation inputs changed before capture.");
  // Detect mutation while asynchronous grant/source checks were running.
  invariant(payloadHash(params.value) === hash, 409, "SOURCE_CHANGED", "Conversation input changed during capture.");
  const receipt: ConversationInputReceipt = Object.freeze({ type: "conversation-input-receipt", payloadHash: hash });
  receipts.set(receipt, { actorScope: actorScope(params.actor), workspaceId: params.workspaceId, payloadHash: hash, roots });
  return receipt;
}

/** Recheck before model calls, response release, copied writes and persistence in the write transaction. */
export async function validateConversationInputReceipt(params: {
  actor: AppActor;
  workspaceId: string;
  value: unknown;
  receipt: ConversationInputReceipt;
  db?: Prisma.TransactionClient;
}): Promise<LineageRoot[]> {
  const state = checkedState(params);
  invariant(await isArtifactInputProofReadable(params.actor, params.workspaceId, state.roots, params.db),
    409, "SOURCE_CHANGED", "Conversation source access changed. Please retry.");
  invariant(state.payloadHash === payloadHash(params.value), 409, "SOURCE_CHANGED", "Conversation input changed during validation.");
  return structuredClone(state.roots);
}

/** The union is all actual admitted context, independently of the model's citations. */
export async function collectConversationInputReceipts(params: {
  actor: AppActor;
  workspaceId: string;
  fragments: readonly ConversationInputFragment[];
  db?: Prisma.TransactionClient;
}): Promise<LineageRoot[]> {
  const fragments = [...params.fragments];
  const proofs: LineageRoot[][] = [];
  for (const fragment of fragments) proofs.push(await validateConversationInputReceipt({ ...params, ...fragment }));
  const roots = mergeRoots(proofs);
  invariant(roots.length > 0, 409, "UNKNOWN_LINEAGE", "Conversation context has no complete source proof.");
  // The last check covers a revocation that occurred while later fragments were checked.
  invariant(await isArtifactInputProofReadable(params.actor, params.workspaceId, roots, params.db),
    409, "SOURCE_CHANGED", "Conversation source access changed. Please retry.");
  invariant(params.fragments.length === fragments.length && fragments.every((fragment, index) => fragment === params.fragments[index]),
    409, "SOURCE_CHANGED", "Conversation context changed during validation.");
  for (const fragment of fragments) checkedState({ ...params, ...fragment });
  return roots;
}

/** Trusted successful mutations may replace consumed revisions only with their exact immutable snapshots. */
export async function rebaseConversationInputReceipt(params: { actor: AppActor; workspaceId: string; value: unknown; receipt: ConversationInputReceipt }) {
  const state = checkedState(params);
  const roots = await rebaseArtifactInputProofToSnapshots(params.actor, params.workspaceId, state.roots);
  invariant(state.payloadHash === payloadHash(params.value), 409, "SOURCE_CHANGED", "Conversation input changed during preservation.");
  state.roots = structuredClone(roots);
}
