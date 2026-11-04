import type { AppActor } from "@corgtex/shared";
import type { LineageRoot } from "@corgtex/domain";

export const saveToBrainTool = {
  type: "function" as const,
  function: {
    name: "save_to_brain",
    description: "Explain how to save an answer to Brain. This tool does not save content or authorize sharing. Direct the user to Save to Brain on a persisted answer, where they choose no transcript, selected turns, or the full transcript and confirm sharing. A chat request alone does not authorize sharing; never report this tool call as a successful save.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Content supplied for the guidance request. It is not saved or accepted as a transcript selection.",
        },
        title: {
          type: "string",
          description: "Suggested title for the guidance request. No Brain source is created.",
        },
        sourceType: {
          type: "string",
          enum: ["CONVERSATION", "MEETING", "DOC", "ARTICLE"],
          description: "Requested content category for compatibility. It does not authorize ingestion or replace meeting-transcript and file-attachment flows.",
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
