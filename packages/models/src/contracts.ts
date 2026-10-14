import type { ModelTaskType } from "@prisma/client";

/** Server-owned authorization, never deserialize this capability from request JSON.
 * Resolve to permit one HTTP send; reject to deny it. Called after headers are
 * prepared on every retry, with the operation's cancellation/deadline signal.
 * This is not a billing reservation or an authorization lease for later sends. */
export type ModelAttemptGuard = (context: Readonly<{ signal: AbortSignal }>) => Promise<void>;

export type ModelRequestControls = {
  signal?: AbortSignal;
  /** Opts into fresh authorization and disables OpenRouter's opaque fallbacks.
   * Guarded OpenRouter multipart transcription is unsupported and fails closed.
   * Callers must propagate these controls into nested model operations. */
  authorizeAttempt?: ModelAttemptGuard;
};

/** Deliberately omits the guard's error/cause, which can contain private data. */
export class ModelAttemptAuthorizationError extends Error {
  readonly code = "MODEL_ATTEMPT_DENIED";

  constructor() {
    super("Model request attempt was not authorized.");
    this.name = "ModelAttemptAuthorizationError";
  }
}

export type ModelUsageInput = {
  workspaceId: string;
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
  provider: string;
  model: string;
  taskType: ModelTaskType;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  estimatedCostUsd?: string;
  rawProviderCostUsd?: string;
  billableCostUsd?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string; // Often used with tool role to identify which tool returned this
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ModelTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
};

export type ChatCompletionRequest = ModelRequestControls & {
  workspaceId: string;
  taskType: ModelTaskType;
  model?: string;
  messages: ChatMessage[];
  tools?: ModelTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function", function: { name: string } };
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
};

export type ChatCompletionResponse = {
  content: string;
  tool_calls?: ToolCall[];
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type ChatStreamEvent =
  | { type: "content_delta"; content: string }
  | {
    type: "tool_call_delta";
    index: number;
    idDelta?: string;
    nameDelta?: string;
    argumentsDelta: string;
  };

export type ExtractionRequest = ModelRequestControls & {
  workspaceId: string;
  model?: string;
  instruction: string;
  input: string;
  schemaHint: string;
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
};

export type ExtractionResponse = {
  output: Record<string, unknown>;
  raw: string;
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type EmbeddingRequest = ModelRequestControls & {
  workspaceId: string;
  model?: string;
  input: string | string[];
  failFastOnRateLimit?: boolean;
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
};

export type EmbeddingResponse = {
  embeddings: number[][];
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type RerankRequest = ModelRequestControls & {
  workspaceId: string;
  model?: string;
  query: string;
  documents: string[];
  topK?: number;
  failFastOnRateLimit?: boolean;
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
};

export type RerankResult = {
  index: number;
  score: number;
  document: string;
};

export type RerankResponse = {
  results: RerankResult[];
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type AudioTranscriptionRequest = ModelRequestControls & {
  workspaceId: string;
  model?: string;
  fileName: string;
  mimeType?: string | null;
  data: Buffer;
  prompt?: string | null;
  language?: string | null;
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
};

export type AudioTranscriptionResponse = {
  text: string;
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type ModelGateway = {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatEventStream(request: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent, ChatCompletionResponse>;
  chatStream(request: ChatCompletionRequest): AsyncGenerator<string, ChatCompletionResponse>;
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  rerank(request: RerankRequest): Promise<RerankResponse>;
  transcribeAudio(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse>;
};
