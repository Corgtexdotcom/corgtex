import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import type { LineageRoot } from "./source-lineage";
import { discardExternalProviderCommitPreflight, prepareExternalProviderRootCommitPreflight, withExternalProviderNativeCommitPreflights,
  type ExternalProviderCommitPreflight } from "./external-provider-authority";
import { discardExternalMcpResponseCommitPreflight, prepareExternalMcpResponseCommitPreflight, withExternalMcpAndSlackCommitPreflights,
  type ExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { discardSlackNativeCommitPreflight, prepareSlackNativeCommitPreflight, type SlackNativeCommitPreflight } from "./communication-native-authority";

declare const mixedBrand: unique symbol;
/** One process-local, single-use capability for the exact mixed native closure. */
export type ExternalMixedCommitPreflight = { readonly [mixedBrand]: true };
type MixedState = { actor: AppActor; workspaceId: string; roots: LineageRoot[];
  provider?: ExternalProviderCommitPreflight; mcp?: ExternalMcpResponseCommitPreflight;
  slack?: SlackNativeCommitPreflight };
const preflights = new WeakMap<object, MixedState>();
const MAX_ROOTS = 10000;

function freezeCopy<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freezeCopy((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Both live provider replays complete before opening the writer transaction. */
export async function prepareExternalMixedCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[]): Promise<ExternalMixedCommitPreflight> {
  const roots = freezeCopy(structuredClone([...originalRoots]));
  invariant(roots.length > 0 && roots.length <= MAX_ROOTS, 409, "SOURCE_CHANGED", "Mixed native proof is unbounded.");
  const { inspectStoredArtifactInputDependencies, assertArtifactInputClosureLocallyAdmissible } = await import("./source-lineage");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots, { maxNodes: MAX_ROOTS });
  invariant(dependencies.complete && dependencies.roots.length <= MAX_ROOTS,
    409, "UNKNOWN_LINEAGE", "Mixed native closure is incomplete.");
  await assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, roots);
  const box = dependencies.roots.some(root => root.kind === "ExternalProviderFetchInput");
  const mcpResponse = dependencies.roots.some(root => root.kind === "ExternalMcpResponseInput");
  const slackMessage = dependencies.roots.some(root => root.kind === "CommunicationMessageNativeInput");
  invariant(Number(box) + Number(mcpResponse) + Number(slackMessage) >= 2,
    409, "UNKNOWN_LINEAGE", "Mixed commit needs multiple proven native sources.");
  const provider = box ? await prepareExternalProviderRootCommitPreflight(actor, workspaceId, roots) : undefined;
  const mcp = mcpResponse ? await prepareExternalMcpResponseCommitPreflight(actor, workspaceId, roots) : undefined;
  const slack = slackMessage ? await prepareSlackNativeCommitPreflight(actor, workspaceId, roots) : undefined;
  const token = Object.freeze({}) as ExternalMixedCommitPreflight;
  preflights.set(token, { actor, workspaceId, roots, provider, mcp, slack });
  return token;
}

/** The provider-owned wrapper is the only executor; it cannot skip locks or full proof checks. */
export async function withExternalMixedCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, submittedRoots: readonly LineageRoot[], token: ExternalMixedCommitPreflight,
  work: () => Promise<T>, beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const state = preflights.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma
    && isDeepStrictEqual(state.roots, submittedRoots),
  409, "SOURCE_CHANGED", "Mixed native commit capability is unavailable.");
  preflights.delete(token);
  try {
    if (state.provider) return await withExternalProviderNativeCommitPreflights(actor, workspaceId, tx,
      state.roots, state.provider, state.mcp, state.slack, work, beforeSourceEpochs);
    invariant(state.mcp && state.slack, 409, "UNKNOWN_LINEAGE", "Mixed native plans are incomplete.");
    return await withExternalMcpAndSlackCommitPreflights(actor, workspaceId, tx, state.roots, state.mcp, state.slack, work, beforeSourceEpochs);
  } finally {
    if (state.provider) discardExternalProviderCommitPreflight(state.provider);
    if (state.mcp) discardExternalMcpResponseCommitPreflight(state.mcp);
    if (state.slack) discardSlackNativeCommitPreflight(state.slack);
  }
}
