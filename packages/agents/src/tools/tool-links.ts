import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import {
  archiveWorkspaceToolLink,
  listWorkspaceToolLinks,
  getWorkspaceToolLinkCredentialAccess,
  getWorkspaceToolLinkInputRoots,
  getConversationOperationOutcomeInputRoots,
  readConversationToolLinkArchiveOutcome,
  captureConversationInputReceipt,
  validateConversationInputReceipt,
  isArtifactInputProofReadable,
  AppError,
  type ConversationInputReceipt,
  type LineageRoot,
  upsertWorkspaceToolLink,
} from "@corgtex/domain";

const toolLinkActionReceipts = new WeakMap<object, ConversationInputReceipt>();
const archiveEffects = new WeakSet<object>();
type ToolLinkContext = { workspaceId: string; lineageRoots?: LineageRoot[]; requestLineageRoots?: LineageRoot[] };

/** Only the exact in-process tool result has a receipt; serialized lookalikes do not. */
export function getToolLinkActionInputReceipt(value: unknown) {
  return value !== null && typeof value === "object" ? toolLinkActionReceipts.get(value) : undefined;
}

/** A terminal operation acknowledgment, independently bound to the current original request. */
export async function getToolLinkArchiveEffectReceipt(actor: AppActor, workspaceId: string, value: object) {
  const receipt = toolLinkActionReceipts.get(value);
  if (!archiveEffects.has(value) || !receipt) throw new AppError(409, "UNKNOWN_LINEAGE", "Archive acknowledgment has no trusted operation receipt.");
  await validateConversationInputReceipt({ actor, workspaceId, value, receipt });
  return receipt;
}

async function bindActionResult(actor: AppActor, workspaceId: string, value: object, roots: LineageRoot[]) {
  toolLinkActionReceipts.set(value, await captureConversationInputReceipt({ actor, workspaceId, value, trustedRoots: roots }));
  return value;
}

export const listToolLinksTool: ModelTool = {
  type: "function",
  function: {
    name: "list_tool_links",
    description: "List shared workspace tools, links, access notes, and whether credentials are configured. Does not reveal credential secrets.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const upsertToolLinkTool: ModelTool = {
  type: "function",
  function: {
    name: "upsert_tool_link",
    description: "Create or update a shared workspace tool link. Pass toolLinkId to update an existing link. Credential values are encrypted and never returned.",
    parameters: {
      type: "object",
      properties: {
        toolLinkId: { type: "string", description: "Existing tool link UUID to update" },
        title: { type: "string" },
        url: { type: "string" },
        category: { type: "string" },
        descriptionMd: { type: "string" },
        accessNotesMd: { type: "string" },
        previewTitle: { type: "string" },
        previewDescription: { type: "string" },
        previewImageUrl: { type: "string" },
        previewFaviconUrl: { type: "string" },
        credentialLabel: { type: "string" },
        credentialSecret: { type: "string" },
        circleIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["title", "url"],
    },
  },
};

export const archiveToolLinkTool: ModelTool = {
  type: "function",
  function: {
    name: "archive_tool_link",
    description: "Archive a shared workspace tool link so it stops appearing in active tools.",
    parameters: {
      type: "object",
      properties: {
        toolLinkId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["toolLinkId"],
    },
  },
};

export const revealToolLinkCredentialTool: ModelTool = {
  type: "function",
  function: {
    name: "reveal_tool_link_credential",
    description: "Open the protected Tools page to reveal a saved credential using the user's current role. Credential values are shown only in that secure UI and never enter chat messages.",
    parameters: {
      type: "object",
      properties: {
        toolLinkId: { type: "string" },
      },
      required: ["toolLinkId"],
    },
  },
};

export async function listToolLinksAction(actor: AppActor, ctx: ToolLinkContext) {
  const links = await listWorkspaceToolLinks(actor, { workspaceId: ctx.workspaceId });
  const value = { items: links };
  await bindActionResult(actor, ctx.workspaceId, value, await getWorkspaceToolLinkInputRoots(actor, ctx.workspaceId, links));
  return value;
}

export async function upsertToolLinkAction(actor: AppActor, ctx: ToolLinkContext, args: any) {
  if (!ctx.lineageRoots?.length) throw new AppError(409, "UNKNOWN_LINEAGE", "Tool link mutation requires the complete model input receipt.");
  if (!await isArtifactInputProofReadable(actor, ctx.workspaceId, ctx.lineageRoots)) throw new AppError(409, "SOURCE_CHANGED", "Tool link inputs changed before persistence.");
  const link = await upsertWorkspaceToolLink(actor, {
    workspaceId: ctx.workspaceId,
    lineageRoots: ctx.lineageRoots,
    toolLinkId: args.toolLinkId,
    title: args.title,
    url: args.url,
    category: args.category,
    descriptionMd: args.descriptionMd,
    accessNotesMd: args.accessNotesMd,
    previewTitle: args.previewTitle,
    previewDescription: args.previewDescription,
    previewImageUrl: args.previewImageUrl,
    previewFaviconUrl: args.previewFaviconUrl,
    credentialLabel: args.credentialLabel,
    credentialSecret: args.credentialSecret,
    circleIds: Array.isArray(args.circleIds) ? args.circleIds : undefined,
  });

  const value = { success: true, toolLinkId: link.id, title: link.title, hasCredential: link.hasCredential };
  await bindActionResult(actor, ctx.workspaceId, value, await getWorkspaceToolLinkInputRoots(actor, ctx.workspaceId, link));
  return value;
}

export async function archiveToolLinkAction(actor: AppActor, ctx: ToolLinkContext, args: any) {
  if (!ctx.requestLineageRoots?.length) throw new AppError(409, "UNKNOWN_LINEAGE", "Archive requires an independent original request receipt.");
  const request = { workspaceId: ctx.workspaceId, toolLinkId: args.toolLinkId, requestLineageRoots: ctx.requestLineageRoots };
  const previous = await readConversationToolLinkArchiveOutcome(actor, request);
  if (previous) {
    await bindActionResult(actor, ctx.workspaceId, previous, await getConversationOperationOutcomeInputRoots(actor, ctx.workspaceId, previous));
    archiveEffects.add(previous);
    return previous;
  }
  if (!ctx.lineageRoots?.length || !await isArtifactInputProofReadable(actor, ctx.workspaceId, ctx.lineageRoots)) {
    throw new AppError(409, "SOURCE_CHANGED", "Archive inputs changed before the operation.");
  }
  const value = await archiveWorkspaceToolLink(actor, { workspaceId: ctx.workspaceId, toolLinkId: args.toolLinkId,
    reason: args.reason, lineageRoots: ctx.lineageRoots, requestLineageRoots: ctx.requestLineageRoots });
  if (!("success" in value)) throw new AppError(409, "UNKNOWN_LINEAGE", "Archive did not provide a committed operation receipt.");
  // A native outcome proves only the constant operational acknowledgment. The
  // old model context remains unreadable after its input is archived.
  await bindActionResult(actor, ctx.workspaceId, value, await getConversationOperationOutcomeInputRoots(actor, ctx.workspaceId, value));
  archiveEffects.add(value);
  return value;
}

export async function revealToolLinkCredentialAction(actor: AppActor, ctx: ToolLinkContext, args: any) {
  const access = await getWorkspaceToolLinkCredentialAccess(actor, { workspaceId: ctx.workspaceId, toolLinkId: args.toolLinkId });
  const value = { success: true, requiresSecureReveal: true, toolLinkId: args.toolLinkId,
    credentialLabel: access.credentialLabel, hasCredential: access.hasCredential,
    webUrl: `/workspaces/${encodeURIComponent(ctx.workspaceId)}/tools`,
    message: "Open Tools and use Reveal for this credential." };
  await bindActionResult(actor, ctx.workspaceId, value, await getWorkspaceToolLinkInputRoots(actor, ctx.workspaceId, access));
  return value;
}
