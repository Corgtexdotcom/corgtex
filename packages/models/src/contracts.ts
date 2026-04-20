import type { ModelTaskType } from "@prisma/client";

export type ModelUsageInput = {
  workspaceId: string;
  workflowJobId?: string;
  agentRunId?: string;
  provider: string;
  model: string;
  taskType: ModelTaskType;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  estimatedCostUsd?: string;
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

export type ChatCompletionRequest = {
  workspaceId: string;
  taskType: ModelTaskType;
  model?: string;
  messages: ChatMessage[];
  tools?: ModelTool[];
  tool_choice?: "auto" | "none" | { type: "function", function: { name: string } };
  workflowJobId?: string;
  agentRunId?: string;
};

export type ChatCompletionResponse = {
  content: string;
  tool_calls?: ToolCall[];
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type ExtractionRequest = {
  workspaceId: string;
  model?: string;
  instruction: string;
  input: string;
  schemaHint: string;
  workflowJobId?: string;
  agentRunId?: string;
};

export type ExtractionResponse = {
  output: Record<string, unknown>;
  raw: string;
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type EmbeddingRequest = {
  workspaceId: string;
  model?: string;
  input: string | string[];
  workflowJobId?: string;
  agentRunId?: string;
};

export type EmbeddingResponse = {
  embeddings: number[][];
  usage: Omit<ModelUsageInput, "workspaceId" | "workflowJobId" | "agentRunId" | "taskType">;
};

export type RerankRequest = {
  workspaceId: string;
  model?: string;
  query: string;
  documents: string[];
  topK?: number;
  workflowJobId?: string;
  agentRunId?: string;
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

export type ModelGateway = {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatStream(request: ChatCompletionRequest): AsyncGenerator<string, ChatCompletionResponse>;
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  rerank(request: RerankRequest): Promise<RerankResponse>;
};
