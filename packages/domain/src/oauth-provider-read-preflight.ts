import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Prisma, OAuthProviderFetchInput } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { isOAuthProviderFetchInputCurrent, isOAuthProviderFetchInputLocallyCurrent } from "./oauth-provider-native";

declare const preflightBrand: unique symbol;
export type OAuthProviderReadCommitPreflight = Readonly<{[preflightBrand]: true}>;
type State = {actor: AppActor; workspaceId: string; roots: readonly LineageRoot[]; inputs: OAuthProviderFetchInput[]};
const prepared = new WeakMap<OAuthProviderReadCommitPreflight, State>();
const active = new AsyncLocalStorage<State & {tx: Prisma.TransactionClient; active: boolean}>();

/** The caller has locally admitted the complete mixed closure before this
 * bounded live native replay. No OAuth provider is called while publishing. */
export async function prepareOAuthProviderReadCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[], nativeRoots: readonly LineageRoot[]): Promise<OAuthProviderReadCommitPreflight | undefined> {
  if (!nativeRoots.length) return undefined;
  const unique = [...new Map(nativeRoots.map(root => [root.id, root])).values()];
  const inputs: OAuthProviderFetchInput[] = [];
  for (const root of unique) {
    const input = await prisma.oAuthProviderFetchInput.findFirst({where: {workspaceId, id: root.id}});
    invariant(input && lineageContentFingerprint("OAuthProviderFetchInput", input) === root.fingerprint
      && await isOAuthProviderFetchInputCurrent(actor, workspaceId, input),
    409, "SOURCE_CHANGED", "OAuth native source access is no longer provable.");
    inputs.push(input);
  }
  const token = Object.freeze({}) as OAuthProviderReadCommitPreflight;
  prepared.set(token, {actor, workspaceId, roots: structuredClone(originalRoots), inputs});
  return token;
}

export function hasOAuthProviderReadCommitAuthority(actor: AppActor, workspaceId: string, input: OAuthProviderFetchInput,
  tx: Prisma.TransactionClient) {
  const state = active.getStore();
  return Boolean(state?.active && state.actor === actor && state.workspaceId === workspaceId && state.tx === tx
    && state.inputs.some(saved => saved.id === input.id && isDeepStrictEqual(saved, input)));
}

export async function withOAuthProviderReadCommitPreflight<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  roots: readonly LineageRoot[], token: OAuthProviderReadCommitPreflight | undefined, work: () => Promise<T>): Promise<T> {
  if (!token) return work();
  const state = prepared.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma && isDeepStrictEqual(state.roots, roots),
    409, "SOURCE_CHANGED", "OAuth native read preflight does not match this commit.");
  prepared.delete(token);
  const current = async () => {
    for (const input of state.inputs) invariant(await isOAuthProviderFetchInputLocallyCurrent(actor, workspaceId, input, tx),
      409, "SOURCE_CHANGED", "OAuth native source policy changed before commit.");
  };
  await current();
  const scope = {...state, tx, active: true};
  return active.run(scope, async () => {
    try {const result = await work(); await current(); return result;}
    finally {scope.active = false;}
  });
}
