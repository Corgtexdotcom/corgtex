import type { ChatCompletionRequest, ChatCompletionResponse } from "@corgtex/models";
import { AssistantHarnessError, authorize, checkCancellation, deliver, snapshotRuntime, snapshotSources } from "./contracts";
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
  const runtime = snapshotRuntime(options.runtime);
  const sources = snapshotSources(options.sources);
  await authorize(runtime, "model", sources);
  await runtime.reserveDispatch("model", options.maximumCalls);
  // The awaited reservation is not an authority lease: revalidate before invoking
  // the gateway. Its internal provider attempts remain gateway-owned.
  await authorize(runtime, "model", sources);
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
    let streamedEvents = 0;
    let failed = false;
    try {
      while (true) {
        const next = await stream.next();
        checkCancellation(runtime);
        if (next.done) {
          if (Buffer.byteLength(JSON.stringify(next.value), "utf8") > options.maximumBytes) throw new AssistantHarnessError("LIMIT");
          return next.value;
        }
        const payloads = next.value.type === "content_delta" ? [next.value.content]
          : [next.value.argumentsDelta, next.value.idDelta ?? "", next.value.nameDelta ?? ""];
        streamedBytes += payloads.reduce((bytes, payload) => bytes + Buffer.byteLength(payload, "utf8"), 0);
        // Content limits do not charge each chunk's repeated event envelope.
        // Separately bound empty/metadata events so they cannot keep a stream alive forever.
        if (++streamedEvents > options.maximumBytes + 1024 || streamedBytes > options.maximumBytes) throw new AssistantHarnessError("LIMIT");
        // Arguments and private graph/checkpoint values are never client events.
        if (next.value.type === "content_delta") await deliver(runtime, next.value, sources);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Closing the generator runs gateway cleanup/accounting even after cancellation.
      try { await stream.return(undefined as never); } catch (error) {
        // A cleanup failure must not replace the primary authorization/limit failure.
        if (!failed) throw error;
      }
    }
  } catch (error) {
    checkCancellation(runtime);
    if (error instanceof AssistantHarnessError) throw error;
    // Provider errors can include prompts, credentials and returned source text.
    throw new AssistantHarnessError("UNAVAILABLE");
  }
}
