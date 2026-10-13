import type { ChatCompletionRequest, ChatCompletionResponse } from "@corgtex/models";
import { AssistantHarnessError, authorize, checkCancellation, deliver } from "./contracts";
import type { AssistantGateway, AssistantRuntime, SourceReference } from "./contracts";

/** The existing gateway remains the only ModelUsage writer and provider/budget owner. */
export async function callAssistantGateway(options: {
  gateway: AssistantGateway;
  runtime: AssistantRuntime;
  request: Pick<ChatCompletionRequest, "messages" | "tools" | "model">;
  sources: readonly SourceReference[];
  maximumCalls: number;
  maximumBytes: number;
  stream: boolean;
}): Promise<ChatCompletionResponse> {
  const { runtime } = options;
  await authorize(runtime, "model", options.sources);
  await runtime.reserveDispatch("model", options.maximumCalls);
  // The awaited reservation is not an authority lease: revalidate before invoking
  // the gateway. Its internal provider attempts remain gateway-owned.
  await authorize(runtime, "model", options.sources);
  const request: ChatCompletionRequest = {
    ...options.request,
    workspaceId: runtime.scope.workspaceId,
    workflowJobId: runtime.scope.job.id,
    agentRunId: runtime.scope.runId,
    taskType: "CHAT",
    signal: runtime.signal,
  };
  try {
    if (!options.stream) {
      const response = await options.gateway.chat(request);
      checkCancellation(runtime);
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > options.maximumBytes) throw new AssistantHarnessError("LIMIT");
      return response;
    }
    const stream = options.gateway.chatEventStream(request);
    let streamedBytes = 0;
    try {
      while (true) {
        const next = await stream.next();
        checkCancellation(runtime);
        if (next.done) {
          if (Buffer.byteLength(JSON.stringify(next.value), "utf8") > options.maximumBytes) throw new AssistantHarnessError("LIMIT");
          return next.value;
        }
        streamedBytes += Buffer.byteLength(JSON.stringify(next.value), "utf8");
        if (streamedBytes > options.maximumBytes) throw new AssistantHarnessError("LIMIT");
        // Arguments and private graph/checkpoint values are never client events.
        if (next.value.type === "content_delta") await deliver(runtime, next.value, options.sources);
      }
    } finally {
      // Closing the generator runs gateway cleanup/accounting even after cancellation.
      await stream.return(undefined as never);
    }
  } catch (error) {
    checkCancellation(runtime);
    if (error instanceof AssistantHarnessError) throw error;
    // Provider errors can include prompts, credentials and returned source text.
    throw new AssistantHarnessError("UNAVAILABLE");
  }
}
