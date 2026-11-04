import { prepareOAuthProviderReadCommitPreflight, withOAuthProviderReadCommitPreflight, type OAuthProviderReadCommitPreflight } from "./oauth-provider-read-preflight";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { invariant } from "./errors";
import { inspectStoredArtifactInputDependencies, isArtifactInputProofReadable, type LineageRoot } from "./source-lineage";
import { assertArtifactInputClosureLocallyAdmissible } from "./source-lineage";
import { withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { prepareSlackNativeCommitPreflight, withSlackNativeCommitPreflight,
  type SlackNativeCommitPreflight } from "./communication-native-authority";
import { prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight,
  type ExternalProviderCommitPreflight } from "./external-provider-authority";
import { prepareExternalMcpResponseCommitPreflight, withExternalMcpResponseCommitPreflight,
  type ExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { prepareExternalMixedCommitPreflight, withExternalMixedCommitPreflight,
  type ExternalMixedCommitPreflight } from "./external-mixed-commit";
import { artifactPermissionEpochIdentities, isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof } from "./source-permission-epochs";
import { prepareSqlNativeReadCommitPreflight, withSqlNativeReadCommitPreflight, type SqlNativeReadCommitPreflight } from "./sql-native-read-preflight";
export { lockArtifactReadAuthorityRows } from "./artifact-read-authority-locks";

declare const commitBrand: unique symbol;
export type ArtifactCommitPreflight = { readonly [commitBrand]: true };
type Backend = { kind: "local" } | { kind: "box"; token: ExternalProviderCommitPreflight }
  | { kind: "mcp"; token: ExternalMcpResponseCommitPreflight } | { kind: "slack"; token: SlackNativeCommitPreflight }
  | { kind: "mixed"; token: ExternalMixedCommitPreflight };
type State = { actor: AppActor; workspaceId: string; roots: LineageRoot[]; backend: Backend; sql?: SqlNativeReadCommitPreflight; oauth?: OAuthProviderReadCommitPreflight };
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
  // The entire caller scope and local ancestry must be admitted before any
  // native child replays a query that can itself contain another source's text.
  await assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, roots);
  // Reject a locally revoked contributor before replaying a request whose query
  // may itself contain its text. These checks confer no remote/read capability.
  const currentCaptures = new Set<string>();
  const originals: LineageRoot[] = [];
  for (const root of dependencies.roots) {
    const saved = root.kind === "ArtifactInputSnapshot"
      ? await prisma.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId },
        select: { epochProofVersion: true, permissionEpochsJson: true } })
      : await prisma.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: root.kind,
        artifactId: root.id, contentHash: root.fingerprint }, orderBy: { revision: "desc" },
      select: { origin: true, inputsJson: true, rootsJson: true, epochProofVersion: true, permissionEpochsJson: true } });
    // A creation vector did not govern a newly consumed human original. Its
    // current capture may regenerate output; all older consumed snapshots and
    // derived/native vectors continue to govern the generations they produced.
    const independentOriginal = root.kind !== "ArtifactInputSnapshot" && saved && "origin" in saved
      && "rootsJson" in saved && "inputsJson" in saved
      && saved.origin === "HUMAN_ORIGINAL" && Array.isArray(saved.rootsJson) && saved.rootsJson.length === 0
      && Array.isArray(saved.inputsJson) && saved.inputsJson.length === 0;
    if (independentOriginal) originals.push(root);
    for (const captured of [root.permissionEpochs, ...(saved && !independentOriginal ? [saved.permissionEpochsJson] : [])]) {
      if (captured === undefined) continue;
      const proof = parsePermissionEpochProof(captured);
      invariant(proof && (!saved || independentOriginal || saved.epochProofVersion === 1)
        && await isArtifactPermissionEpochProofCurrent(workspaceId, proof, prisma),
      409, "SOURCE_CHANGED", "Commit local source permissions changed before replay.");
      for (const entry of proof.entries) currentCaptures.add(JSON.stringify([entry.kind, entry.id]));
    }
  }
  // Synthesized source entries may use their enclosing snapshot/derived vector;
  // a bare original with no capture cannot skip its only local authority check.
  for (const original of originals) {
    // The first identity is the artifact's own governor; transcript/agenda
    // projections intentionally share their Meeting identity.
    const self = artifactPermissionEpochIdentities(original.kind, { id: original.id })[0];
    invariant(self && currentCaptures.has(JSON.stringify([self.kind, self.id])),
      409, "UNKNOWN_LINEAGE", "Commit original has no current consumed permission capture.");
  }
  const box = dependencies.roots.some(root => root.kind === "ExternalProviderFetchInput");
  // A connection-set absence proof is local control data: its captured policy
  // epoch locks later insertions without inventing a provider response to replay.
  const mcp = dependencies.roots.some(root => root.kind === "ExternalMcpResponseInput");
  const slack = dependencies.roots.some(root => root.kind === "CommunicationMessageNativeInput");
  const sql = await prepareSqlNativeReadCommitPreflight(actor, workspaceId, roots,
    dependencies.roots.filter(root => root.kind === "SqlNativeRunInput"));
  const oauth = await prepareOAuthProviderReadCommitPreflight(actor, workspaceId, roots, dependencies.roots.filter(root => root.kind === "OAuthProviderFetchInput"));
  const backend: Backend = Number(box) + Number(mcp) + Number(slack) >= 2
    ? { kind: "mixed", token: await prepareExternalMixedCommitPreflight(actor, workspaceId, roots) }
    : box ? { kind: "box", token: await prepareExternalProviderRootCommitPreflight(actor, workspaceId, roots) }
    : mcp ? { kind: "mcp", token: await prepareExternalMcpResponseCommitPreflight(actor, workspaceId, roots) }
    : slack ? { kind: "slack", token: await prepareSlackNativeCommitPreflight(actor, workspaceId, roots) }
    : { kind: "local" };
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots), 409, "SOURCE_CHANGED", "Commit source permissions changed.");
  const token = Object.freeze({}) as ArtifactCommitPreflight;
  preflights.set(token, { actor, workspaceId, roots, backend, sql, oauth });
  return token;
}

/** Every branch runs the complete proof before and after DB-only work. The
 * optional physical source-row reservation runs after native/governing locks,
 * before the first full proof; it cannot bypass that proof or grant a capability. */
export async function withArtifactCommitPreflight<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  originalRoots: readonly LineageRoot[], token: ArtifactCommitPreflight, work: () => Promise<T>,
  options?: { beforeSourceEpochs: () => Promise<void> }): Promise<T> {
  const beforeSourceEpochs = options?.beforeSourceEpochs;
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
  return withOAuthProviderReadCommitPreflight(actor, workspaceId, tx, originalRoots, state.oauth, () => withSqlNativeReadCommitPreflight(actor, workspaceId, tx, originalRoots, state.sql, () => withArtifactNativeCommitPhase(() => {
    if (backend.kind === "box") return withExternalProviderCommitPreflight(actor, workspaceId, tx, backend.token, verified, beforeSourceEpochs);
    if (backend.kind === "mcp") return withExternalMcpResponseCommitPreflight(actor, workspaceId, tx, backend.token, verified, beforeSourceEpochs);
    if (backend.kind === "slack") return withSlackNativeCommitPreflight(actor, workspaceId, tx, state.roots, backend.token, verified, beforeSourceEpochs);
    if (backend.kind === "mixed") return withExternalMixedCommitPreflight(actor, workspaceId, tx, state.roots, backend.token, verified, beforeSourceEpochs);
    return (async () => { await beforeSourceEpochs?.(); return verified(); })();
  })));
}
