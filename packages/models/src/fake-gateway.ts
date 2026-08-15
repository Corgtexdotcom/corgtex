import { env, cosineSimilarity } from "@corgtex/shared";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamEvent,
  EmbeddingRequest,
  ExtractionRequest,
  ModelGateway,
  ModelUsageInput,
  RerankRequest,
  AudioTranscriptionRequest,
} from "./contracts";
import { assertCatalogModelBudget, assertWorkspaceModelBudget, recordModelUsage } from "./usage";

function usageDetails(input: ModelUsageInput) {
  return {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    latencyMs: input.latencyMs ?? 0,
    estimatedCostUsd: input.estimatedCostUsd ?? "0.000000",
    rawProviderCostUsd: input.rawProviderCostUsd ?? "0.000000",
    billableCostUsd: input.billableCostUsd ?? input.estimatedCostUsd ?? "0.000000",
  };
}

function usageContext(request: {
  catalogItemId?: string | null;
  agentCredentialId?: string | null;
}) {
  return {
    catalogItemId: request.catalogItemId ?? undefined,
    agentCredentialId: request.agentCredentialId ?? undefined,
  };
}

function abortedError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortedError(signal);
  }
}

async function delay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const abort = () => {
      cleanup();
      reject(abortedError(signal));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
  throwIfAborted(signal);
}

function fakeEmbeddingVector(input: string, size = 16) {
  const vector = Array.from({ length: size }, () => 0);
  const normalized = input.trim().toLowerCase();

  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    vector[index % size] += (code % 31) / 31;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}


function groundedResponse(request: ChatCompletionRequest) {
  const userContent = request.messages.at(-1)?.content ?? "";
  const match = userContent.match(/SNIPPETS:\n([\s\S]*)/);
  if (!match) {
    return null;
  }

  const firstSnippet = match[1]
    .split(/\n\n+/)
    .map((value) => value.trim())
    .find(Boolean);

  if (!firstSnippet) {
    return "I could not find supporting indexed knowledge.";
  }

  return `Grounded answer based on indexed knowledge: ${firstSnippet.slice(0, 180)} [1]`;
}

async function recordUsage(input: ModelUsageInput) {
  await recordModelUsage(input);
  return usageDetails(input);
}

async function* fakeChatEventStream(
  request: ChatCompletionRequest,
): AsyncGenerator<ChatStreamEvent, ChatCompletionResponse> {
  const response = await fakeModelGateway.chat(request);
  for (const chunk of response.content.match(/\S+\s*|\s+/g) ?? []) {
    throwIfAborted(request.signal);
    yield { type: "content_delta", content: chunk };
    await delay(10, request.signal);
  }
  return response;
}

async function* fakeChatStream(
  request: ChatCompletionRequest,
): AsyncGenerator<string, ChatCompletionResponse> {
  const events = fakeChatEventStream(request);
  let completed = false;
  try {
    while (true) {
      const next = await events.next();
      if (next.done) {
        completed = true;
        return next.value;
      }
      if (next.value.type === "content_delta") yield next.value.content;
    }
  } finally {
    if (!completed) await events.return(undefined as never);
  }
}

export const fakeModelGateway: ModelGateway = {
  async chat(request: ChatCompletionRequest) {
    const startedAt = Date.now();
    throwIfAborted(request.signal);
    await assertWorkspaceModelBudget(request.workspaceId);
    await assertCatalogModelBudget({
      workspaceId: request.workspaceId,
      ...usageContext(request),
    });
    throwIfAborted(request.signal);
    const content = groundedResponse(request)
      ?? `FAKE_MODEL_RESPONSE\n\n${request.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")}`;
    const latencyMs = Date.now() - startedAt;
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: env.MODEL_PROVIDER,
      model: request.model ?? env.MODEL_CHAT_DEFAULT,
      taskType: request.taskType,
      inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
      outputTokens: Math.ceil(content.length / 4),
      latencyMs,
      estimatedCostUsd: "0.000000",
    });

    return { content, usage };
  },

  async *chatEventStream(request: ChatCompletionRequest) {
    return yield* fakeChatEventStream(request);
  },

  async *chatStream(request: ChatCompletionRequest) {
    return yield* fakeChatStream(request);
  },

  async extract(request: ExtractionRequest) {
    const startedAt = Date.now();
    await assertWorkspaceModelBudget(request.workspaceId);
    await assertCatalogModelBudget({
      workspaceId: request.workspaceId,
      ...usageContext(request),
    });
    let output: Record<string, unknown>;
    if (/actions/i.test(request.schemaHint) || /action/i.test(request.instruction)) {
      output = {
        actions: [
          {
            title: request.input.slice(0, 60) || "Follow up on meeting decisions",
            rationale: "Generated by fake extraction output.",
          },
        ],
      };
    } else if (/title/i.test(request.schemaHint) && /body/i.test(request.schemaHint)) {
      output = {
        title: request.input.slice(0, 60) || "Draft proposal",
        summary: request.input.slice(0, 120),
        bodyMd: request.input,
      };
    } else {
      output = {
        instruction: request.instruction,
        summary: request.input.slice(0, 160),
        schemaHint: request.schemaHint,
      };
    }
    const raw = JSON.stringify(output);
    const latencyMs = Date.now() - startedAt;
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: env.MODEL_PROVIDER,
      model: request.model ?? env.MODEL_CHAT_DEFAULT,
      taskType: "EXTRACTION",
      inputTokens: request.input.length,
      outputTokens: Math.ceil(raw.length / 4),
      latencyMs,
      estimatedCostUsd: "0.000000",
    });

    return {
      output,
      raw,
      usage,
    };
  },

  async embed(request: EmbeddingRequest) {
    const startedAt = Date.now();
    await assertWorkspaceModelBudget(request.workspaceId);
    await assertCatalogModelBudget({
      workspaceId: request.workspaceId,
      ...usageContext(request),
    });
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const embeddings = inputs.map((input) => fakeEmbeddingVector(input));
    const latencyMs = Date.now() - startedAt;
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: env.MODEL_PROVIDER,
      model: request.model ?? env.MODEL_EMBEDDING_DEFAULT,
      taskType: "EMBEDDING",
      inputTokens: inputs.reduce((sum, value) => sum + value.length, 0),
      outputTokens: 0,
      latencyMs,
      estimatedCostUsd: "0.000000",
    });

    return {
      embeddings,
      usage,
    };
  },

  async rerank(request: RerankRequest) {
    const startedAt = Date.now();
    await assertWorkspaceModelBudget(request.workspaceId);
    await assertCatalogModelBudget({
      workspaceId: request.workspaceId,
      ...usageContext(request),
    });
    const queryEmbedding = fakeEmbeddingVector(request.query);
    const ranked = request.documents
      .map((document, index) => ({
        index,
        document,
        score: Number(cosineSimilarity(queryEmbedding, fakeEmbeddingVector(document)).toFixed(6)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(request.topK ?? request.documents.length, request.documents.length)));
    const latencyMs = Date.now() - startedAt;
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: env.MODEL_PROVIDER,
      model: request.model ?? env.MODEL_EMBEDDING_DEFAULT,
      taskType: "RERANK",
      inputTokens: request.query.length + request.documents.reduce((sum, value) => sum + value.length, 0),
      outputTokens: 0,
      latencyMs,
      estimatedCostUsd: "0.000000",
    });

    return {
      results: ranked,
      usage,
    };
  },

  async transcribeAudio(request: AudioTranscriptionRequest) {
    const startedAt = Date.now();
    await assertWorkspaceModelBudget(request.workspaceId);
    await assertCatalogModelBudget({
      workspaceId: request.workspaceId,
      ...usageContext(request),
    });
    const text = `Fake transcript for ${request.fileName} (${request.data.byteLength} bytes).`;
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      ...usageContext(request),
      provider: env.MODEL_PROVIDER,
      model: request.model ?? env.MODEL_TRANSCRIPTION_DEFAULT ?? "fake-transcribe",
      taskType: "TRANSCRIPTION",
      inputTokens: 0,
      outputTokens: Math.ceil(text.length / 4),
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: "0.000000",
    });

    return { text, usage };
  },
};
