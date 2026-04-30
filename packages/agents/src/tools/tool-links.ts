import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import {
  archiveWorkspaceToolLink,
  listWorkspaceToolLinks,
  revealWorkspaceToolLinkCredential,
  upsertWorkspaceToolLink,
} from "@corgtex/domain";

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
    description: "Reveal the saved credential for a shared tool link. This is sensitive and audited, and follows the user's current Corgtex role.",
    parameters: {
      type: "object",
      properties: {
        toolLinkId: { type: "string" },
      },
      required: ["toolLinkId"],
    },
  },
};

export async function listToolLinksAction(actor: AppActor, ctx: { workspaceId: string }) {
  const links = await listWorkspaceToolLinks(actor, { workspaceId: ctx.workspaceId });
  return { items: links };
}

export async function upsertToolLinkAction(actor: AppActor, ctx: { workspaceId: string }, args: any) {
  const link = await upsertWorkspaceToolLink(actor, {
    workspaceId: ctx.workspaceId,
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

  return {
    success: true,
    toolLinkId: link.id,
    title: link.title,
    hasCredential: link.hasCredential,
  };
}

export async function archiveToolLinkAction(actor: AppActor, ctx: { workspaceId: string }, args: any) {
  await archiveWorkspaceToolLink(actor, {
    workspaceId: ctx.workspaceId,
    toolLinkId: args.toolLinkId,
    reason: args.reason,
  });

  return { success: true, toolLinkId: args.toolLinkId };
}

export async function revealToolLinkCredentialAction(actor: AppActor, ctx: { workspaceId: string }, args: any) {
  const credential = await revealWorkspaceToolLinkCredential(actor, {
    workspaceId: ctx.workspaceId,
    toolLinkId: args.toolLinkId,
  });

  return {
    toolLinkId: args.toolLinkId,
    credentialLabel: credential.credentialLabel,
    credentialSecret: credential.credentialSecret,
  };
}
