import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { reserveArtifactWriteHeads } from "./artifact-write-heads";
import { assertSourceCommitTransactionCompatible, hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import {
  advanceHumanArtifactInputLineage,
  captureArtifactInputProof,
  captureArtifactInputSnapshotProof,
  currentArtifactInputRoots,
  invalidateArtifactInputLineage,
  isArtifactInputProofReadable,
  lineageContentFingerprint,
  recordArtifactInputLineage,
  type LineageInput,
  type LineageRoot,
} from "./source-lineage";

export type ProducerLineageParams = {
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
};

type ProducerReceipt =
  | { mode: "UNKNOWN" }
  | { mode: "ADVANCE"; before: unknown; allowSystemTransition: boolean }
  | { mode: "HUMAN_ORIGINAL" | "DERIVED"; inputs: LineageInput[]; roots: LineageRoot[] };

/** Prepare receipts before mutation, so a partial edit cannot certify an unproven old body. */
export async function prepareProducerLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact?: LineageInput;
  before?: unknown;
  capture?: ProducerLineageParams;
  dependencies?: Array<LineageInput & { snapshot?: Record<string, unknown> }>;
  copied?: boolean;
  /** A deterministic copier declares every field-bearing source here. */
  completeCopy?: boolean;
  snapshotDependencies?: LineageInput[];
  allowSystemTransition?: boolean;
}): Promise<ProducerReceipt> {
  const { tx, actor, workspaceId, before } = params;
  const artifact = params.artifact ? Object.freeze({kind: params.artifact.kind, id: params.artifact.id}) : undefined;
  assertSourceCommitTransactionCompatible(tx);
  // Active plans already reserved outputs before any row locks: only assert coverage.
  // Standalone callers must use the explicit batch helper at their earlier lock seam.
  if (artifact && hasActiveSourceCommitLockPlan(tx)) await reserveArtifactWriteHeads(tx, workspaceId, [artifact]);
  const submissionRoots = getMcpToolInputRoots(actor, workspaceId);
  const capture = { ...params.capture, lineageRoots: [...(params.capture?.lineageRoots ?? []), ...submissionRoots] };
  const explicit = Boolean(capture.lineageInputs?.length || capture.lineageRoots?.length);
  if (before !== undefined && !explicit && !params.completeCopy && !params.dependencies?.length) {
    if (params.copied) return { mode: "UNKNOWN" };
    return { mode: "ADVANCE", before, allowSystemTransition: params.allowSystemTransition ?? false };
  }
  // An agent's ids alone do not prove what its earlier model prompt contained.
  if ((actor.kind !== "user" || params.copied) && !capture.lineageRoots?.length && !params.completeCopy) return { mode: "UNKNOWN" };
  let inputs = [...(capture.lineageInputs ?? []), ...(params.dependencies ?? [])];
  let roots = [...(capture.lineageRoots ?? [])];
  if (roots.length) invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
    409, "SOURCE_CHANGED", "Producer inputs changed before persistence.");
  if (before !== undefined && artifact) {
    const prior = await currentArtifactInputRoots(tx, workspaceId, artifact, before);
    if (!prior) {
      invariant(!submissionRoots.length, 409, "UNKNOWN_LINEAGE", "A partial MCP edit cannot prove the existing content safe.");
      return { mode: "UNKNOWN" };
    }
    let snapshotRoots: LineageRoot[];
    try {
      snapshotRoots = await captureArtifactInputSnapshotProof(actor, workspaceId,
        { ...artifact, fingerprint: lineageContentFingerprint(artifact.kind, before) }, tx);
    } catch (error) {
      if (!explicit && typeof error === "object" && error !== null && "code" in error
        && error.code === "UNKNOWN_LINEAGE") return { mode: "UNKNOWN" };
      throw error;
    }
    inputs = inputs.filter((input) => input.kind !== artifact.kind || input.id !== artifact.id);
    roots = [...roots.filter((root) => root.kind !== artifact.kind || root.id !== artifact.id), ...snapshotRoots];
  }
  if (inputs.length) {
    try {
      roots.push(...await captureArtifactInputProof(actor, workspaceId, inputs, tx));
    } catch (error) {
      // Legacy related records cannot be assumed independent. Explicit receipts must be valid.
      if (!explicit && typeof error === "object" && error !== null && "code" in error && error.code === "UNKNOWN_LINEAGE") {
        return { mode: "UNKNOWN" };
      }
      throw error;
    }
  }
  for (const input of params.snapshotDependencies ?? []) {
    const captured = roots.find((root) => root.kind === input.kind && root.id === input.id);
    invariant(captured, 409, "UNKNOWN_LINEAGE", "A copied input was not captured.");
    const snapshots = await captureArtifactInputSnapshotProof(actor, workspaceId, captured, tx);
    roots = [...roots.filter((root) => root.kind !== input.kind || root.id !== input.id), ...snapshots];
    inputs = inputs.filter((candidate) => candidate.kind !== input.kind || candidate.id !== input.id);
  }
  if (!inputs.length && !roots.length && actor.kind !== "user") return { mode: "UNKNOWN" };
  return { mode: inputs.length || roots.length ? "DERIVED" : "HUMAN_ORIGINAL",
    inputs: inputs.map(({ kind, id }) => ({ kind, id })), roots };
}

/** Persist the receipt atomically with the producer's content write. */
export async function finishProducerLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
  receipt: ProducerReceipt;
}) {
  const { receipt, ...base } = params;
  if (receipt.mode === "UNKNOWN") return invalidateArtifactInputLineage(base);
  if (receipt.mode === "ADVANCE") {
    try {
      return await advanceHumanArtifactInputLineage({
        tx: base.tx, actor: base.actor, workspaceId: base.workspaceId, artifact: base.artifact,
        before: receipt.before, after: base.content, allowSystemTransition: receipt.allowSystemTransition,
      });
    } catch (error) {
      if (!receipt.allowSystemTransition || typeof error !== "object" || error === null
        || !("code" in error) || error.code !== "SOURCE_RESTRICTED") throw error;
      return invalidateArtifactInputLineage(base);
    }
  }
  return recordArtifactInputLineage({ ...base, origin: receipt.mode,
    inputs: receipt.inputs, inheritedRoots: receipt.roots });
}
