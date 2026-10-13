import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

const toolCall = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export const publicationSelection = z.object({
  result: z.string().min(1).max(100_000),
  approvedContextSummary: z.string().min(1).max(20_000).optional(),
}).strict();
export const runState = z.object({
  version: z.literal(1),
  graphVersion: z.literal("personal-conversation-v1"),
  binding: z.object({ runId: z.string(), workspaceId: z.string(), userId: z.string(), conversationId: z.string(), policyVersion: z.string() }).strict(),
  configurationDigest: z.string(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(), name: z.string().optional(),
    tool_calls: z.array(toolCall).optional(), tool_call_id: z.string().optional(),
  }).strict()),
  sources: z.array(z.object({ kind: z.enum(["brain", "meeting"]), id: z.string() }).strict()),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  corrections: z.number().int().nonnegative(),
  calls: z.array(toolCall),
  pending: z.object({
    operationId: z.string(), call: toolCall, selection: publicationSelection,
    reference: z.object({ id: z.string().min(1), selectionDigest: z.string().min(1) }).strict(),
  }).strict().nullable(),
  status: z.enum(["model", "tools", "approval", "effect", "done", "unknown"]),
  receiptIds: z.array(z.string()),
}).strict();
export type AssistantState = z.infer<typeof runState>;
export const AssistantGraphState = Annotation.Root({ data: Annotation<AssistantState>() });
