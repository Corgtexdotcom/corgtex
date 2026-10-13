import type { ChatMessage, ModelGateway, ModelTool } from "@corgtex/models";
import type { HumanActor } from "@corgtex/shared";
import type { z } from "zod";

export const ASSISTANT_GRAPH_VERSION = "personal-conversation-v1";

/** Resolved from authenticated admission and the current job claim, never model/job JSON. */
export type AssistantScope = Readonly<{
  runId: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  policyVersion: string;
  job: Readonly<{ id: string; owner: string; attempt: number }>;
}>;

export type SourceReference = { kind: "brain" | "meeting"; id: string };
export type AssistantOperation = "load" | "model" | "read" | "approval" | "effect" | "result";
export type AssistantLimits = Readonly<{
  modelCalls: number;
  toolCalls: number;
  corrections: number;
  contentBytes: number;
}>;

export type AssistantReadTool = {
  name: "read_brain" | "read_meeting";
  description: string;
  parameters: ModelTool["function"]["parameters"];
  arguments: z.ZodType<unknown>;
  /** Must apply domain permissions to the exact query and return source provenance. */
  execute(args: unknown, runtime: AssistantRuntime): Promise<{
    content: string;
    sources: SourceReference[];
  }>;
};

export type PublicationSelection = { result: string; approvedContextSummary?: string };
export type ApprovalReference = { id: string; selectionDigest: string };

/** Views of app-owned receipts, not a new persisted receipt representation. */
export type EffectKnowledge =
  | { status: "NOT_COMMITTED" }
  | { status: "COMMITTED"; receiptId: string }
  | { status: "UNKNOWN" };

export type PublicationPort = {
  /** Idempotent preparation bound to this run, operation and exact immutable selection. */
  prepare(runtime: AssistantRuntime, operationId: string, selection: PublicationSelection): Promise<ApprovalReference>;
  /** Reload and validate exact selection, decision identity, expiry and current authority. */
  decision(runtime: AssistantRuntime, reference: ApprovalReference, selection: PublicationSelection): Promise<"PENDING" | "APPROVED" | "DENIED">;
  inspect(runtime: AssistantRuntime, operationId: string, reference: ApprovalReference): Promise<EffectKnowledge>;
  /** Atomically reauthorize, fence claim, validate approval, dedupe effect and commit its receipt/outbox. */
  commit(runtime: AssistantRuntime, operationId: string, reference: ApprovalReference, selection: PublicationSelection): Promise<Exclude<EffectKnowledge, { status: "NOT_COMMITTED" }>>;
};

export type AssistantEvent =
  | { type: "content_delta"; content: string }
  | { type: "tool_start"; name: AssistantReadTool["name"] | "publish_selection" }
  | { type: "tool_end"; name: AssistantReadTool["name"] | "publish_selection"; outcome: "ok" | "error" };

export type AssistantRuntime = {
  scope: AssistantScope;
  actor: HumanActor;
  signal: AbortSignal;
  /** Fresh app check: membership, claim, cancellation, budget and ALL saved source permissions. */
  authorize(operation: AssistantOperation, sources: readonly SourceReference[]): Promise<void>;
  /** Durable app reservation for EACH actual dispatch, including retries after checkpoint loss.
   * Atomically enforce the supplied run-wide maximum and claim. Not a billing write. */
  reserveDispatch(kind: "model" | "tool", maximum: number): Promise<void>;
  /** Optional ephemeral subscriber; disconnect detaches it, never cancels the admitted turn. */
  emit?: (event: AssistantEvent) => void;
};

export type AssistantInput = {
  /** Loaded from the permitted personal conversation; no system/tool/control messages. */
  messages: Array<Pick<ChatMessage, "content"> & { role: "user" | "assistant" }>;
};

export type AssistantCapabilities = {
  reads: readonly AssistantReadTool[];
  /** Omit unless the authenticated request permits proposing selected-result publication. */
  publication?: PublicationPort;
  /** Present only for a user-requested structured result. */
  artifact?: { schema: z.ZodType<unknown>; instruction: string };
};

export type AssistantGateway = Pick<ModelGateway, "chat" | "chatEventStream">;

export class AssistantHarnessError extends Error {
  constructor(readonly code: "DISABLED" | "SCOPE" | "VERSION" | "LIMIT" | "CANCELLED" | "UNAVAILABLE" | "CHECKPOINT" | "INPUT") {
    super(`Assistant harness: ${code}`);
    this.name = "AssistantHarnessError";
  }
}

export function checkCancellation(runtime: AssistantRuntime) {
  if (runtime.signal.aborted) throw new AssistantHarnessError("CANCELLED");
}

export async function authorize(runtime: AssistantRuntime, operation: AssistantOperation, sources: readonly SourceReference[]) {
  checkCancellation(runtime);
  try { await runtime.authorize(operation, sources); } catch (error) {
    if (error instanceof AssistantHarnessError) throw error;
    throw new AssistantHarnessError("SCOPE");
  }
  checkCancellation(runtime);
}

export function emit(runtime: AssistantRuntime, event: AssistantEvent) {
  // Subscriber failures must not restart billed work or undo a committed effect.
  try { runtime.emit?.(event); } catch { /* detached subscriber */ }
}
