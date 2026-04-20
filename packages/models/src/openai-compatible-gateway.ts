import { env, cosineSimilarity } from "@corgtex/shared";
import type {
  ChatCompletionRequest,
  EmbeddingRequest,
  ExtractionRequest,
  ModelGateway,
  ModelUsageInput,
  RerankRequest,
} from "./contracts";
import { recordModelUsage } from "./usage";

type UsageDetails = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: string;
};

type ChatCompletionApiResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: import("./contracts").ToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type EmbeddingApiResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  usage?: {
    prompt_tokens?: number;
  };
};

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_RETRIES = 2;
const OPENROUTER_TITLE = "Corgtex";

class ExtractionParseError extends Error {
  readonly raw: string;
  readonly repairedRaw?: string;

  constructor(message: string, options: {
    raw: string;
    repairedRaw?: string;
  }) {
    super(message);
    this.name = "ExtractionParseError";
    this.raw = options.raw;
    this.repairedRaw = options.repairedRaw;
  }
}

function baseUrl() {
  return env.MODEL_BASE_URL?.replace(/\/+$/, "") ?? "https://api.openai.com/v1";
}

function requireApiKey() {
  if (!env.MODEL_API_KEY) {
    throw new Error("MODEL_API_KEY is required for the OpenAI-compatible model provider.");
  }

  return env.MODEL_API_KEY;
}

function usageDetails(input: ModelUsageInput): UsageDetails {
  return {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    latencyMs: input.latencyMs ?? 0,
    estimatedCostUsd: input.estimatedCostUsd ?? "0.000000",
  };
}

function estimateCostUsd(inputTokens: number, outputTokens: number) {
  // Cost estimation logic varies heavily by tier/model.
  // We track raw token usage so we can calculate this retroactively if needed.
  return undefined;
}

function isOpenRouterProvider() {
  return env.MODEL_PROVIDER === "openrouter";
}

function requestHeaders() {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${requireApiKey()}`,
  };

  if (isOpenRouterProvider()) {
    headers["HTTP-Referer"] = env.APP_URL;
    headers["X-Title"] = OPENROUTER_TITLE;
  }

  return headers;
}

function withProviderOptions(body: Record<string, unknown>) {
  if (!isOpenRouterProvider()) {
    return body;
  }

  return {
    ...body,
    provider: {
      allow_fallbacks: true,
      data_collection: "deny",
    },
  };
}

function retryDelayMs(attempt: number) {
  return 250 * 2 ** attempt;
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function isRetryableRequestError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof SyntaxError) {
    return false;
  }

  return error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<TResponse>(path: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(withProviderOptions(body));
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl()}${path}`, {
        method: "POST",
        headers: requestHeaders(),
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI-compatible request failed (${response.status}): ${errorText}`);
        if (attempt < MAX_REQUEST_RETRIES && isRetryableStatus(response.status)) {
          lastError = error;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }

      return response.json() as Promise<TResponse>;
    } catch (error) {
      if (attempt >= MAX_REQUEST_RETRIES || !isRetryableRequestError(error)) {
        throw error;
      }

      lastError = error;
      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError ?? new Error("OpenAI-compatible request failed after retries.");
}

function normalizeContent(content: string | Array<{ type?: string; text?: string }> | undefined) {
  if (typeof content === "string") {
    return content;
  }

  return (content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJsonObject(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFences(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function extractOuterJsonObject(input: string) {
  const start = input.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && inString) {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseExtractionObject(raw: string) {
  const trimmed = raw.trim();
  const stripped = stripCodeFences(trimmed);
  const candidates = [
    trimmed,
    stripped,
    extractOuterJsonObject(stripped),
    extractOuterJsonObject(trimmed),
  ].filter((candidate, index, values): candidate is string => {
    return typeof candidate === "string" && candidate.length > 0 && values.indexOf(candidate) === index;
  });

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

async function recordUsage(input: ModelUsageInput) {
  await recordModelUsage(input);
  return usageDetails(input);
}

async function completeChat(
  request: ChatCompletionRequest,
  taskType: ModelUsageInput["taskType"],
  modelOverride?: string,
  bodyExtras?: Record<string, unknown>,
) {
  const startedAt = Date.now();
  const model = modelOverride ?? request.model ?? env.MODEL_CHAT_DEFAULT;
  const response = await postJson<ChatCompletionApiResponse>("/chat/completions", {
    model,
    temperature: 0.2,
    messages: request.messages,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
    ...(bodyExtras ?? {}),
  });
  const latencyMs = Date.now() - startedAt;
  const content = normalizeContent(response.choices?.[0]?.message?.content);
  const tool_calls = response.choices?.[0]?.message?.tool_calls;
  const inputTokens = response.usage?.prompt_tokens ?? request.messages.reduce((sum, message) => sum + message.content.length, 0);
  const outputTokens = response.usage?.completion_tokens ?? Math.ceil(content.length / 4);
  const usage = await recordUsage({
    workspaceId: request.workspaceId,
    workflowJobId: request.workflowJobId,
    agentRunId: request.agentRunId,
    provider: env.MODEL_PROVIDER,
    model,
    taskType,
    inputTokens,
    outputTokens,
    latencyMs,
    estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
  });

  return { content, tool_calls, usage };
}

async function* completeChatStream(
  request: ChatCompletionRequest,
  taskType: ModelUsageInput["taskType"],
  modelOverride?: string,
  bodyExtras?: Record<string, unknown>,
): AsyncGenerator<string, import("./contracts").ChatCompletionResponse> {
  const startedAt = Date.now();
  const model = modelOverride ?? request.model ?? env.MODEL_CHAT_DEFAULT;
  const payload = JSON.stringify(withProviderOptions({
    model,
    temperature: 0.2,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
    ...(bodyExtras ?? {}),
  }));

  let response: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: requestHeaders(),
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI-compatible request failed (${response.status}): ${errorText}`);
        if (attempt < MAX_REQUEST_RETRIES && isRetryableStatus(response.status)) {
          lastError = error;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }
      break;
    } catch (error) {
      if (attempt >= MAX_REQUEST_RETRIES || !isRetryableRequestError(error)) {
        throw error;
      }
      lastError = error;
      await sleep(retryDelayMs(attempt));
    }
  }

  if (!response) throw lastError ?? new Error("OpenAI-compatible request failed after retries.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable.");

  const decoder = new TextDecoder();
  let content = "";
  let tool_calls: any[] = [];
  let usageDetailsObj: any = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          
          if (delta?.content) {
            content += delta.content;
            yield delta.content;
          }
          
          if (delta?.tool_calls) {
            for (const tool of delta.tool_calls) {
              const index = tool.index;
              if (tool_calls[index]) {
                tool_calls[index].function.arguments += tool.function?.arguments || "";
              } else {
                tool_calls[index] = {
                  id: tool.id,
                  type: "function",
                  function: {
                    name: tool.function?.name || "",
                    arguments: tool.function?.arguments || "",
                  }
                };
              }
            }
          }
          if (data.usage) usageDetailsObj = data.usage;
        } catch (e) {
          // ignore
        }
      }
    }
  }
  
  const finalTools: import("./contracts").ToolCall[] = tool_calls.filter(Boolean);
  const latencyMs = Date.now() - startedAt;
  const inputTokens = usageDetailsObj?.prompt_tokens ?? request.messages.reduce((sum, message) => sum + message.content.length, 0);
  const outputTokens = usageDetailsObj?.completion_tokens ?? Math.ceil(content.length / 4);
  const usage = await recordUsage({
    workspaceId: request.workspaceId,
    workflowJobId: request.workflowJobId,
    agentRunId: request.agentRunId,
    provider: env.MODEL_PROVIDER,
    model,
    taskType,
    inputTokens,
    outputTokens,
    latencyMs,
    estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
  });

  return { content, tool_calls: finalTools.length > 0 ? finalTools : undefined, usage };
}

async function repairExtractionObject(request: ExtractionRequest, raw: string) {
  const repaired = await completeChat({
    workspaceId: request.workspaceId,
    workflowJobId: request.workflowJobId,
    agentRunId: request.agentRunId,
    taskType: "EXTRACTION",
    model: request.model,
    messages: [
      {
        role: "system",
        content: `Rewrite the invalid extraction output into a valid JSON object only. Follow this schema hint exactly: ${request.schemaHint}`,
      },
      {
        role: "user",
        content: `ORIGINAL_INSTRUCTION:\n${request.instruction}\n\nRAW_OUTPUT:\n${raw}`,
      },
    ],
  }, "EXTRACTION", request.model, {
    temperature: 0,
    response_format: {
      type: "json_object",
    },
  });

  return {
    raw: repaired.content,
    output: parseExtractionObject(repaired.content),
    usage: repaired.usage,
  };
}

async function embedTexts(request: EmbeddingRequest) {
  const startedAt = Date.now();
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  const model = request.model ?? env.MODEL_EMBEDDING_DEFAULT;
  const response = await postJson<EmbeddingApiResponse>("/embeddings", {
    model,
    input: inputs,
  });
  const latencyMs = Date.now() - startedAt;
  const embeddings = (response.data ?? []).map((entry) => entry.embedding ?? []);
  const inputTokens = response.usage?.prompt_tokens ?? inputs.reduce((sum, value) => sum + value.length, 0);

  return {
    model,
    embeddings,
    inputTokens,
    latencyMs,
  };
}

export const openAICompatibleModelGateway: ModelGateway = {
  async chat(request: ChatCompletionRequest) {
    return completeChat(request, request.taskType);
  },

  async *chatStream(request: ChatCompletionRequest) {
    return yield* completeChatStream(request, request.taskType);
  },

  async extract(request: ExtractionRequest) {
    const response = await completeChat({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      taskType: "EXTRACTION",
      model: request.model,
      messages: [
        {
          role: "system",
          content: `Return a valid JSON object only. Follow this schema hint: ${request.schemaHint}`,
        },
        {
          role: "user",
          content: `${request.instruction}\n\nINPUT:\n${request.input}`,
        },
      ],
    }, "EXTRACTION", request.model, {
      temperature: 0,
      response_format: {
        type: "json_object",
      },
    });

    const parsed = parseExtractionObject(response.content);
    if (parsed) {
      return {
        output: parsed,
        raw: response.content,
        usage: response.usage,
      };
    }

    const repaired = await repairExtractionObject(request, response.content);
    if (repaired.output) {
      return {
        output: repaired.output,
        raw: repaired.raw,
        usage: repaired.usage,
      };
    }

    throw new ExtractionParseError("Failed to parse extraction output after repair attempt.", {
      raw: response.content,
      repairedRaw: repaired.raw,
    });
  },

  async embed(request: EmbeddingRequest) {
    const embedded = await embedTexts(request);
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      provider: env.MODEL_PROVIDER,
      model: embedded.model,
      taskType: "EMBEDDING",
      inputTokens: embedded.inputTokens,
      outputTokens: 0,
      latencyMs: embedded.latencyMs,
      estimatedCostUsd: estimateCostUsd(embedded.inputTokens, 0),
    });

    return {
      embeddings: embedded.embeddings,
      usage,
    };
  },

  async rerank(request: RerankRequest) {
    const embedded = await embedTexts({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      model: request.model ?? env.MODEL_EMBEDDING_DEFAULT,
      input: [request.query, ...request.documents],
    });
    const [queryEmbedding, ...documentEmbeddings] = embedded.embeddings;
    const results = request.documents
      .map((document, index) => ({
        index,
        document,
        score: Number(cosineSimilarity(queryEmbedding ?? [], documentEmbeddings[index] ?? []).toFixed(6)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(request.topK ?? request.documents.length, request.documents.length)));
    const usage = await recordUsage({
      workspaceId: request.workspaceId,
      workflowJobId: request.workflowJobId,
      agentRunId: request.agentRunId,
      provider: env.MODEL_PROVIDER,
      model: embedded.model,
      taskType: "RERANK",
      inputTokens: embedded.inputTokens,
      outputTokens: 0,
      latencyMs: embedded.latencyMs,
      estimatedCostUsd: estimateCostUsd(embedded.inputTokens, 0),
    });

    return {
      results,
      usage,
    };
  },
};
