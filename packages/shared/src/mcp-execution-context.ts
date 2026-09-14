import { AsyncLocalStorage } from "node:async_hooks";

type McpExecutionOrigin = { connectionId: string; workspaceId: string };
const context = new AsyncLocalStorage<McpExecutionOrigin | undefined>();

export const getMcpExecutionOrigin = () => context.getStore();
export function runWithMcpExecutionOrigin<T>(origin: McpExecutionOrigin | undefined, run: () => PromiseLike<T>): Promise<T> {
  return context.run(origin, async () => await run());
}
