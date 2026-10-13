import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { invariant } from "./errors";
import { inspectStoredArtifactInputDependencies, isArtifactInputProofReadable, type LineageRoot } from "./source-lineage";
import { prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight,
  type ExternalProviderCommitPreflight } from "./external-provider-authority";
import { prepareExternalMcpResponseCommitPreflight, withExternalMcpResponseCommitPreflight,
  type ExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { prepareExternalMixedCommitPreflight, withExternalMixedCommitPreflight,
  type ExternalMixedCommitPreflight } from "./external-mixed-commit";
import { isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof } from "./source-permission-epochs";

declare const commitBrand: unique symbol;
export type ArtifactCommitPreflight = { readonly [commitBrand]: true };
type Backend = { kind: "local" } | { kind: "box"; token: ExternalProviderCommitPreflight }
  | { kind: "mcp"; token: ExternalMcpResponseCommitPreflight } | { kind: "mixed"; token: ExternalMixedCommitPreflight };
type State = { actor: AppActor; workspaceId: string; roots: LineageRoot[]; backend: Backend };
const preflights = new WeakMap<object, State>();
const MAX_NODES = 10000;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Select only supported native adapters from the entire stored closure. All
 * live replays happen before the caller opens its publication transaction. */
export async function prepareArtifactCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[]): Promise<ArtifactCommitPreflight> {
  sealArtifactInputActor(actor);
  const roots = freeze(structuredClone([...originalRoots]));
  invariant(roots.length > 0 && roots.length <= MAX_NODES, 409, "UNKNOWN_LINEAGE", "Commit requires bounded complete input proofs.");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots, { maxNodes: MAX_NODES });
  invariant(dependencies.complete && dependencies.roots.length <= MAX_NODES,
    409, "UNKNOWN_LINEAGE", "Commit input closure is incomplete or unbounded.");
  invariant(!dependencies.roots.some(root => root.kind === "CommunicationMessageNativeInput"),
    409, "UNKNOWN_LINEAGE", "Slack native inputs require a transaction-safe commit adapter.");
  // Reject a locally revoked contributor before replaying a request whose query
  // may itself contain its text. These checks confer no remote/read capability.
  for (const root of dependencies.roots) {
    const saved = root.kind === "ArtifactInputSnapshot"
      ? await prisma.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId },
        select: { epochProofVersion: true, permissionEpochsJson: true } })
      : await prisma.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: root.kind,
        artifactId: root.id, contentHash: root.fingerprint }, orderBy: { revision: "desc" },
      select: { epochProofVersion: true, permissionEpochsJson: true } });
    for (const captured of [root.permissionEpochs, ...(saved ? [saved.permissionEpochsJson] : [])]) {
      if (captured === undefined) continue;
      const proof = parsePermissionEpochProof(captured);
      invariant(proof && (!saved || saved.epochProofVersion === 1)
        && await isArtifactPermissionEpochProofCurrent(workspaceId, proof, prisma),
      409, "SOURCE_CHANGED", "Commit local source permissions changed before replay.");
    }
  }
  const box = dependencies.roots.some(root => root.kind === "ExternalProviderFetchInput");
  // A connection-set absence proof is local control data: its captured policy
  // epoch locks later insertions without inventing a provider response to replay.
  const mcp = dependencies.roots.some(root => root.kind === "ExternalMcpResponseInput");
  const backend: Backend = box && mcp ? { kind: "mixed", token: await prepareExternalMixedCommitPreflight(actor, workspaceId, roots) }
    : box ? { kind: "box", token: await prepareExternalProviderRootCommitPreflight(actor, workspaceId, roots) }
    : mcp ? { kind: "mcp", token: await prepareExternalMcpResponseCommitPreflight(actor, workspaceId, roots) }
    : { kind: "local" };
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots), 409, "SOURCE_CHANGED", "Commit source permissions changed.");
  const token = Object.freeze({}) as ArtifactCommitPreflight;
  preflights.set(token, { actor, workspaceId, roots, backend });
  return token;
}

/** Every branch runs the complete proof before and after DB-only work. */
export async function withArtifactCommitPreflight<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  originalRoots: readonly LineageRoot[], token: ArtifactCommitPreflight, work: () => Promise<T>): Promise<T> {
  const state = preflights.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma
    && isDeepStrictEqual(state.roots, originalRoots), 409, "SOURCE_CHANGED", "Commit input capability is unavailable.");
  preflights.delete(token);
  const verified = async () => {
    invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx), 409, "SOURCE_CHANGED", "Commit sources changed before writing.");
    const result = await work();
    invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx), 409, "SOURCE_CHANGED", "Commit sources changed during writing.");
    return result;
  };
  const backend = state.backend;
  if (backend.kind === "box") return withExternalProviderCommitPreflight(actor, workspaceId, tx, backend.token, verified);
  if (backend.kind === "mcp") return withExternalMcpResponseCommitPreflight(actor, workspaceId, tx, backend.token, verified);
  if (backend.kind === "mixed") return withExternalMixedCommitPreflight(actor, workspaceId, tx, state.roots, backend.token, verified);
  return verified();
}
