import { prisma, type AppActor } from "@corgtex/shared";

type HandlerObservation = {
  toolName: string;
  handlerState: "entered" | "returned" | "rejected";
  effectState: "unknown";
};

/** Server observations, never a committed-effect receipt or replay authority.
 * Only constructed after authenticated conversation input admission. Nothing
 * copied from tool args, output, errors or the abort reason is persisted.
 */
export class ConversationInterruptionJournal {
  private readonly calls: HandlerObservation[] = [];

  async observe<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
    const observation: HandlerObservation = { toolName, handlerState: "entered", effectState: "unknown" };
    this.calls.push(observation);
    try {
      const value = await handler();
      observation.handlerState = "returned";
      return value;
    } catch (error) {
      observation.handlerState = "rejected";
      throw error;
    }
  }

  async persist(ctx: { workspaceId: string; promptInputId?: string; ingressInputId?: string }, actor: AppActor) {
    const entityId = ctx.promptInputId ?? ctx.ingressInputId;
    try {
      if (!entityId) throw new Error("No admitted conversation input.");
      // Operational audit only: deliberately outside the canceled content-write
      // fence, without creating lineage, assistant output, or another model call.
      // The prior admission binds workspace/principal/input. Revoked content
      // access cannot turn these fixed server observations into copied content.
      await prisma.auditLog.create({ data: {
        workspaceId: ctx.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "conversation.interrupted",
        entityType: ctx.promptInputId ? "ConversationPromptInput" : "ConversationIngressInput",
        entityId,
        meta: { version: 1, status: "CANCELED", observationScope: "model_tool_handlers",
          calls: this.calls.map(call => ({ ...call })) },
      } });
    } catch {
      // The write may have committed before its response failed. Do not retry,
      // claim durability, or mask cancellation with a persistence error.
      console.warn("Conversation interruption audit persistence could not be confirmed.");
    }
  }
}
