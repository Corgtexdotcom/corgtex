import type { AppActor } from "@corgtex/shared";
import type { LineageRoot } from "@corgtex/domain";

export const saveToBrainTool = {
  type: "function" as const,
  function: {
    name: "save_to_brain",
    description: "Explain how to save an answer to Brain. This tool does not save content or authorize sharing. Direct the user to Save to Brain on a persisted answer, where they choose transcript metadata and confirm sharing.",
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

export async function saveToBrainAction(_actor: AppActor, _ctx: { workspaceId: string; lineageRoots?: LineageRoot[] }, _args: {
  content: string; title: string; sourceType?: string;
}) {
  return { success: false, message: "Use Save to Brain on the answer, then choose whether to include no transcript, selected turns, or the full transcript. Only your confirmation can share conversation content." };
}
