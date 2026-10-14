import { AsyncLocalStorage } from "node:async_hooks";
import type { AppActor } from "@corgtex/shared";
import type { LineageRoot } from "./source-lineage";

type ToolInputContext = { actor: AppActor; identity: string; workspaceId: string; roots: readonly LineageRoot[] };
const context = new AsyncLocalStorage<ToolInputContext>();

export function mcpToolInputActorIdentity(actor: AppActor) {
  return actor.kind === "user" ? JSON.stringify({ kind: actor.kind, user: actor.user }) : JSON.stringify({ ...actor,
    workspaceIds: [...(actor.workspaceIds ?? [])].sort(), scopes: [...new Set(actor.scopes ?? [])].sort() });
}

/** Server scope only: serialized/model-supplied roots never enter this context. */
export function getMcpToolInputRoots(actor: AppActor, workspaceId: string): LineageRoot[] {
  const current = context.getStore();
  if (!current) return [];
  if (current.actor !== actor || current.workspaceId !== workspaceId || current.identity !== mcpToolInputActorIdentity(actor)) {
    throw Object.assign(new Error("MCP tool input does not belong to this operation."), { status: 403, code: "MCP_INPUT_SCOPE_MISMATCH" });
  }
  return current.roots.map((root) => ({ ...root }));
}

export function withMcpToolInputContext<T>(actor: AppActor, workspaceId: string, roots: readonly LineageRoot[], work: () => PromiseLike<T>,
  expectedIdentity = mcpToolInputActorIdentity(actor)): Promise<T> {
  if (expectedIdentity !== mcpToolInputActorIdentity(actor)) {
    throw Object.assign(new Error("MCP tool principal changed during capture."), { status: 403, code: "MCP_INPUT_SCOPE_MISMATCH" });
  }
  const inherited = getMcpToolInputRoots(actor, workspaceId);
  const complete = new Map<string, LineageRoot>();
  for (const root of [...inherited, ...roots]) {
    const key = `${root.kind}:${root.id}`;
    const prior = complete.get(key);
    if (prior && prior.fingerprint !== root.fingerprint) throw new Error("MCP tool input revisions conflict.");
    complete.set(key, Object.freeze({ ...root }));
  }
  return context.run({ actor, identity: expectedIdentity, workspaceId, roots: Object.freeze([...complete.values()]) }, async () => await work());
}
