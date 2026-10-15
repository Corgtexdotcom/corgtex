import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { vi } from "vitest";
import type { ToolCall } from "@corgtex/models";
import type { AssistantRuntime } from "../contracts";
import type { AssistantHarnessOptions } from "../graph";
import type { ClaimedCheckpointPort } from "../checkpoint-store";

export const input = { messages: [{ role: "user" as const, content: "Synthetic acceptance prompt" }] };
export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
export const toolCall = (name: string, args: unknown = {}, id = "synthetic-call"): ToolCall => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
export function success(content = "Synthetic answer", calls?: ToolCall[]) {
  return Response.json({ choices: [{ message: { content, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
}

/** Synthetic application ports and MemorySaver checkpoints are NOT proof of real PostgreSQL durability,
 * transactional authorization, receipts, outbox delivery, or worker-claim fencing. */
export async function acceptanceFixture(overrides: Partial<AssistantHarnessOptions> = {}) {
  for (const [key, value] of Object.entries({
    MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "synthetic-not-a-credential",
    MODEL_BASE_URL: "https://provider.invalid/v1", MODEL_CHAT_DEFAULT: "acceptance-fixture",
    MODEL_REQUEST_TIMEOUT_MS: "180000", MODEL_PROVIDER_ROUTES_JSON: "[]",
    MODEL_PRICE_OVERRIDES_JSON: JSON.stringify([{ provider: "openrouter", model: "acceptance-fixture", inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002 }]),
  })) vi.stubEnv(key, value);
  const { openAICompatibleModelGateway } = await import("../../../../models/src/openai-compatible-gateway");
  const { createAssistantHarness } = await import("../graph");
  const { AssistantHarnessError } = await import("../contracts");
  const memory = new MemorySaver();
  const controller = new AbortController();
  const authority = { member: true, claim: true, cancelled: false, revokedSources: new Set<string>() };
  const reservations = { model: 0, tool: 0 };
  const check = () => {
    if (authority.cancelled) throw new AssistantHarnessError("CANCELLED");
    if (!authority.member || !authority.claim) throw new AssistantHarnessError("SCOPE");
  };
  const runtime: AssistantRuntime = {
    scope: { workspaceId: "ws-acceptance", userId: "user-acceptance", conversationId: "conversation-acceptance", runId: "run-acceptance", policyVersion: "policy-acceptance", job: { id: "job-acceptance", owner: "worker-acceptance", attempt: 1 } },
    actor: { kind: "user", user: { id: "user-acceptance", email: "synthetic@example.invalid", displayName: "Synthetic" } },
    signal: controller.signal,
    authorize: vi.fn<AssistantRuntime["authorize"]>(async (_operation, sources) => {
      check();
      if (sources.some(source => authority.revokedSources.has(source.id))) throw new AssistantHarnessError("SCOPE");
    }),
    reserveDispatch: vi.fn<AssistantRuntime["reserveDispatch"]>(async (kind, maximum) => {
      check();
      if (reservations[kind] >= maximum) throw new AssistantHarnessError("LIMIT");
      reservations[kind]++;
    }),
    delivery: { audience: { workspaceId: "ws-acceptance", userId: "user-acceptance", conversationId: "conversation-acceptance" }, deliver: vi.fn(async () => "DELIVERED" as const) },
  };
  const checkpoints: ClaimedCheckpointPort = {
    getTuple: async (_scope, config) => { check(); return memory.getTuple(config); },
    put: async (_scope, config, checkpoint, metadata) => { check(); return memory.put(config, checkpoint, metadata); },
    putWrites: async (_scope, config, writes, taskId) => { check(); return memory.putWrites(config, writes, taskId); },
  };
  const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected synthetic HTTP request"));
  vi.stubGlobal("fetch", fetchMock);
  const options: AssistantHarnessOptions = { enabled: true, workspaceEnabled: true, gateway: openAICompatibleModelGateway, checkpoints, capabilities: { reads: [] }, ...overrides };
  return { runtime, options, memory, checkpoints, controller, authority, reservations, fetchMock,
    runner: () => createAssistantHarness(options, runtime), success };
}
