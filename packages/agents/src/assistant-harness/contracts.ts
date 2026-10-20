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
  /** Idempotent preparation bound to this run, operation and exact selection/sources.
   * Revalidate membership, source access, claim and cancellation inside the SAME
   * transaction as preparation writes. A prior caller check is not a write fence. */
  prepare(runtime: AssistantRuntime, operationId: string, selection: PublicationSelection, sources: readonly SourceReference[]): Promise<ApprovalReference>;
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

export type AssistantDeliveryContext = Readonly<{
  scope: AssistantScope;
  actor: HumanActor;
  signal: AbortSignal;
  sources: readonly SourceReference[];
}>;

export type AssistantDeliveryPort = {
  /** Bound by authenticated subscription setup to the ACTUAL personal connection. */
  readonly audience: Readonly<Pick<AssistantScope, "workspaceId" | "userId" | "conversationId">>;
  /** One guarded handoff: revalidate this recipient's session, ownership, claim,
   * cancellation and exact source permissions at delivery. Serialize revocation
   * against handoff; a separate check followed by an unguarded send is insufficient.
   * DETACHED means no send and is not an authorization failure. DENIED means no send.
   * Throw on unknown authorization failure; never downgrade it to DETACHED. */
  deliver(context: AssistantDeliveryContext, event: AssistantEvent): Promise<"DELIVERED" | "DETACHED" | "DENIED">;
};

export type AssistantRuntime = {
  scope: AssistantScope;
  actor: HumanActor;
  signal: AbortSignal;
  /** Fresh app check: membership, claim, cancellation, budget and ALL saved source permissions. */
  authorize(operation: AssistantOperation, sources: readonly SourceReference[]): Promise<void>;
  /** Durable reservation for EACH harness gateway/read-tool invocation, including
   * replays after checkpoint loss. Atomically enforce the run-wide maximum and claim.
   * A later denial does not refund this reservation. Not billing or a reservation
   * for each internal provider HTTP retry/fallback; those remain gateway-owned. */
  reserveDispatch(kind: "model" | "tool", maximum: number): Promise<void>;
  /** Omit unless the app can provide the guarded delivery contract below.
   * Disconnect detaches the subscription, never cancels the admitted turn. */
  delivery?: AssistantDeliveryPort;
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

/** Capture admitted identity and port selection, never the mutable live policy behind ports. */
export function snapshotRuntime(runtime: AssistantRuntime): AssistantRuntime {
  return Object.freeze({
    signal: runtime.signal,
    authorize: runtime.authorize.bind(runtime),
    reserveDispatch: runtime.reserveDispatch.bind(runtime),
    scope: Object.freeze({ ...runtime.scope, job: Object.freeze({ ...runtime.scope.job }) }),
    actor: Object.freeze({ ...runtime.actor, user: Object.freeze({ ...runtime.actor.user }) }),
    delivery: runtime.delivery ? Object.freeze({
      deliver: runtime.delivery.deliver.bind(runtime.delivery),
      audience: Object.freeze({ ...runtime.delivery.audience }),
    }) : undefined,
  });
}

export function snapshotSources(sources: readonly SourceReference[]): readonly SourceReference[] {
  return Object.freeze(sources.map(source => Object.freeze({ ...source })));
}

export function checkCancellation(runtime: AssistantRuntime) {
  if (runtime.signal.aborted) throw new AssistantHarnessError("CANCELLED");
}

export async function authorize(runtime: AssistantRuntime, operation: AssistantOperation, sources: readonly SourceReference[]) {
  checkCancellation(runtime);
  try { await runtime.authorize(operation, snapshotSources(sources)); } catch (error) {
    if (error instanceof AssistantHarnessError) throw error;
    throw new AssistantHarnessError("SCOPE");
  }
  checkCancellation(runtime);
}

export async function deliver(runtime: AssistantRuntime, event: AssistantEvent, sources: readonly SourceReference[]) {
  checkCancellation(runtime);
  const port = runtime.delivery;
  if (!port) return;
  if (runtime.actor.kind !== "user" || runtime.actor.user.id !== runtime.scope.userId ||
      port.audience.workspaceId !== runtime.scope.workspaceId || port.audience.userId !== runtime.scope.userId ||
      port.audience.conversationId !== runtime.scope.conversationId) throw new AssistantHarnessError("SCOPE");
  const context: AssistantDeliveryContext = Object.freeze({
    scope: Object.freeze({ ...runtime.scope, job: Object.freeze({ ...runtime.scope.job }) }),
    actor: Object.freeze({ ...runtime.actor, user: Object.freeze({ ...runtime.actor.user }) }),
    signal: runtime.signal,
    sources: Object.freeze(sources.map(source => Object.freeze({ ...source }))),
  });
  try {
    const outcome = await port.deliver(context, Object.freeze({ ...event }));
    checkCancellation(runtime);
    if (outcome !== "DELIVERED" && outcome !== "DETACHED") throw new AssistantHarnessError("SCOPE");
  } catch (error) {
    checkCancellation(runtime);
    if (error instanceof AssistantHarnessError) throw error;
    throw new AssistantHarnessError("SCOPE");
  }
}
