import type { AppActor } from "@corgtex/shared";
import { ingestConversationOnDemand } from "@corgtex/domain";

export const saveToBrainTool = {
  type: "function" as const,
  function: {
    name: "save_to_brain",
    description: "Save the current conversation content or a specific piece of information to the Brain knowledge base for permanent storage. Use when the user explicitly asks to save, upload, store, or remember something. This ensures the data is fed into the organizational knowledge graph.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The content to save. Can be the full conversation, a transcript the user pasted, or specific information the user wants stored.",
        },
        title: {
          type: "string",
          description: "A descriptive title for the brain source.",
        },
        sourceType: {
          type: "string",
          enum: ["CONVERSATION", "MEETING", "DOC", "ARTICLE"],
          description: "The type of content being saved. Use MEETING for transcripts, DOC for documents, CONVERSATION for chat content.",
        },
      },
      required: ["content", "title"],
    },
  },
};

export async function saveToBrainAction(actor: AppActor, ctx: { workspaceId: string }, args: {
  content: string;
  title: string;
  sourceType?: string;
}) {
  const source = await ingestConversationOnDemand(actor, {
    workspaceId: ctx.workspaceId,
    content: args.content,
    title: args.title,
    sourceType: args.sourceType,
  });

  return {
    success: true,
    message: `Content saved successfully to the Brain as a ${args.sourceType || "CONVERSATION"} source. It is queued for absorption.`,
    sourceId: source.id
  };
}
