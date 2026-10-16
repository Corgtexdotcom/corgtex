import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Prisma, SqlNativeRunInput } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { isSqlNativeRunInputCurrent, isSqlNativeRunInputLocallyCurrent, loadSqlNativeRunInput } from "./sql-native-input";

declare const preflightBrand: unique symbol;
export type SqlNativeReadCommitPreflight = Readonly<{[preflightBrand]: true}>;
type State = {actor: AppActor; workspaceId: string; roots: readonly LineageRoot[]; inputs: SqlNativeRunInput[]};
const prepared = new WeakMap<SqlNativeReadCommitPreflight, State>();
const active = new AsyncLocalStorage<State & {tx: Prisma.TransactionClient; active: boolean}>();

/** The caller has locally admitted the complete mixed closure before this
 * bounded live native replay. No SQL provider is called while publishing. */
export async function prepareSqlNativeReadCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[], nativeRoots: readonly LineageRoot[]): Promise<SqlNativeReadCommitPreflight | undefined> {
  if (!nativeRoots.length) return undefined;
  const unique = [...new Map(nativeRoots.map(root => [root.id, root])).values()];
  const inputs: SqlNativeRunInput[] = [];
  for (const root of unique) {
    const input = await loadSqlNativeRunInput(workspaceId, root.id);
    invariant(input && lineageContentFingerprint("SqlNativeRunInput", input) === root.fingerprint
      && await isSqlNativeRunInputCurrent(actor, workspaceId, input),
    409, "SOURCE_CHANGED", "SQL native source access is no longer provable.");
    inputs.push(input);
  }
  const token = Object.freeze({}) as SqlNativeReadCommitPreflight;
  prepared.set(token, {actor, workspaceId, roots: structuredClone(originalRoots), inputs});
  return token;
}

export function hasSqlNativeReadCommitAuthority(actor: AppActor, workspaceId: string, input: SqlNativeRunInput,
  tx: Prisma.TransactionClient) {
  const state = active.getStore();
  return Boolean(state?.active && state.actor === actor && state.workspaceId === workspaceId && state.tx === tx
    && state.inputs.some(saved => saved.id === input.id && isDeepStrictEqual(saved, input)));
}

export async function withSqlNativeReadCommitPreflight<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  roots: readonly LineageRoot[], token: SqlNativeReadCommitPreflight | undefined, work: () => Promise<T>): Promise<T> {
  if (!token) return work();
  const state = prepared.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma && isDeepStrictEqual(state.roots, roots),
    409, "SOURCE_CHANGED", "SQL native read preflight does not match this commit.");
  prepared.delete(token);
  const current = async () => {
    for (const input of state.inputs) invariant(await isSqlNativeRunInputLocallyCurrent(actor, workspaceId, input, tx),
      409, "SOURCE_CHANGED", "SQL native source policy changed before commit.");
  };
  await current();
  const scope = {...state, tx, active: true};
  return active.run(scope, async () => {
    try {const result = await work(); await current(); return result;}
    finally {scope.active = false;}
  });
}
