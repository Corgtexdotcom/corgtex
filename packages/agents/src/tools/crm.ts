import type { AppActor } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import { completeActivity, createActivity, createCommunicationSuggestion, listCrmActivities } from "@corgtex/domain";

type CrmToolContext = {
  workspaceId: string;
  pageContext?: {
    surface: string;
    selectedIds?: {
      accountId?: string | null;
      activityId?: string | null;
    };
  } | null;
};

export const CRM_WRITE_TOOL_NAMES = new Set([
  "record_relationship_activity",
  "complete_relationship_activity",
  "create_communication_suggestion",
]);

function definedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function selectedAccountId(ctx: CrmToolContext, value?: string | null) {
  return value ?? (ctx.pageContext?.surface === "crm" ? ctx.pageContext.selectedIds?.accountId ?? undefined : undefined);
}

function selectedActivityId(ctx: CrmToolContext, value?: string | null) {
  return value ?? (ctx.pageContext?.surface === "crm" ? ctx.pageContext.selectedIds?.activityId ?? undefined : undefined);
}

function crmPath(workspaceId: string, path: string) {
  return `/workspaces/${workspaceId}${path}`;
}

function activityWebUrl(workspaceId: string, activity: any) {
  return activity.accountId
    ? crmPath(workspaceId, `/leads/accounts/${activity.accountId}?view=activity`)
    : crmPath(workspaceId, "/leads/activity");
}

function activityResult(workspaceId: string, activity: any) {
  return {
    id: activity.id,
    title: activity.title,
    type: activity.type,
    accountId: activity.accountId ?? null,
    dueAt: activity.dueAt ?? null,
    completedAt: activity.completedAt ?? null,
    webUrl: activityWebUrl(workspaceId, activity),
  };
}

export function normalizeCrmWriteToolArgs(toolName: string, ctx: CrmToolContext, args: any) {
  if (toolName === "record_relationship_activity") {
    return definedEntries({
      title: args.title,
      type: args.type,
      bodyMd: args.bodyMd,
      accountId: selectedAccountId(ctx, args.accountId),
      contactId: args.contactId,
      dealId: args.dealId,
      dueAt: args.dueAt,
    });
  }

  if (toolName === "complete_relationship_activity") {
    return definedEntries({
      activityId: selectedActivityId(ctx, args.activityId),
      completedAt: args.completedAt,
    });
  }

  if (toolName === "create_communication_suggestion") {
    return definedEntries({
      title: args.title,
      bodyMd: args.bodyMd,
      subject: args.subject,
      recipientEmail: args.recipientEmail,
      recipientName: args.recipientName,
      channel: args.channel,
      accountId: selectedAccountId(ctx, args.accountId),
      contactId: args.contactId,
      dealId: args.dealId,
      activityId: args.activityId,
    });
  }

  return args;
}

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateCrmWriteToolArgs(toolName: string, args: Record<string, unknown>) {
  if (toolName === "complete_relationship_activity" && !hasNonEmptyString(args.activityId)) {
    throw new Error("A CRM activity ID is required to prepare a pending CRM activity completion.");
  }
}

export const crmTools: ModelTool[] = [
  {
    type: "function",
    function: {
      name: "list_due_relationship_work",
      description: "List open CRM follow-up tasks and reminders. This reads tracked relationship work only and does not send email.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "Defaults to the selected CRM page account when available." },
          contactId: { type: "string" },
          dealId: { type: "string" },
          dueTo: { type: "string", description: "Optional ISO upper bound." },
          take: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_relationship_activity",
      description: "Prepare a pending CRM note, task, activity, or follow-up for explicit user confirmation. This does not send email or execute until the pending operation is confirmed.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", description: "NOTE, EMAIL, CALL, MEETING, TASK, or another CRM activity type." },
          bodyMd: { type: "string" },
          accountId: { type: "string", description: "Defaults to the selected CRM page account when available." },
          contactId: { type: "string" },
          dealId: { type: "string" },
          dueAt: { type: "string", description: "Optional ISO due date for reminders." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_relationship_activity",
      description: "Prepare a pending completion for a CRM activity or follow-up reminder. This closes tracked work only after the pending operation is confirmed and does not send email.",
      parameters: {
        type: "object",
        properties: {
          activityId: { type: "string", description: "Defaults to the selected CRM page activity when available." },
          completedAt: { type: "string", description: "Optional ISO completion timestamp." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_communication_suggestion",
      description: "Prepare a pending CRM communication suggestion draft for explicit user confirmation. Corgtex stores the draft only after confirmation; it does not send email.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          bodyMd: { type: "string" },
          subject: { type: "string" },
          recipientEmail: { type: "string" },
          recipientName: { type: "string" },
          channel: { type: "string" },
          accountId: { type: "string", description: "Defaults to the selected CRM page account when available." },
          contactId: { type: "string" },
          dealId: { type: "string" },
          activityId: { type: "string" },
        },
        required: ["title", "bodyMd"],
      },
    },
  },
];

export async function listDueRelationshipWorkAction(actor: AppActor, ctx: CrmToolContext, args: any) {
  const result = await listCrmActivities(actor, ctx.workspaceId, {
    accountId: selectedAccountId(ctx, args.accountId),
    contactId: args.contactId,
    dealId: args.dealId,
    type: "TASK",
    completion: "open",
    sort: "due",
    dueTo: args.dueTo ? new Date(args.dueTo) : undefined,
    take: typeof args.take === "number" ? Math.min(Math.max(Math.trunc(args.take), 1), 25) : 10,
  });
  return {
    total: result.total,
    items: result.items.map((activity: any) => activityResult(ctx.workspaceId, activity)),
    webUrl: crmPath(ctx.workspaceId, "/leads/activity"),
  };
}

export async function recordRelationshipActivityAction(actor: AppActor, ctx: CrmToolContext, args: any) {
  const activity = await createActivity(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    type: args.type,
    bodyMd: args.bodyMd,
    accountId: selectedAccountId(ctx, args.accountId),
    contactId: args.contactId,
    dealId: args.dealId,
    source: "workspace-chat",
    dueAt: args.dueAt ? new Date(args.dueAt) : undefined,
  });
  return { success: true, activity: activityResult(ctx.workspaceId, activity) };
}

export async function completeRelationshipActivityAction(actor: AppActor, ctx: CrmToolContext, args: any) {
  const activityId = selectedActivityId(ctx, args.activityId);
  if (!activityId) throw new Error("A CRM activity ID is required.");
  const activity = await completeActivity(actor, {
    workspaceId: ctx.workspaceId,
    activityId,
    completedAt: args.completedAt ? new Date(args.completedAt) : undefined,
  });
  return { success: true, activity: activityResult(ctx.workspaceId, activity) };
}

export async function createCommunicationSuggestionAction(actor: AppActor, ctx: CrmToolContext, args: any) {
  const suggestion = await createCommunicationSuggestion(actor, {
    workspaceId: ctx.workspaceId,
    title: args.title,
    bodyMd: args.bodyMd,
    subject: args.subject,
    recipientEmail: args.recipientEmail,
    recipientName: args.recipientName,
    channel: args.channel,
    accountId: selectedAccountId(ctx, args.accountId),
    contactId: args.contactId,
    dealId: args.dealId,
    activityId: args.activityId,
    source: "workspace-chat",
  });
  return {
    success: true,
    emailSent: false,
    suggestion: {
      id: suggestion.id,
      title: suggestion.title,
      status: suggestion.status,
      accountId: suggestion.accountId ?? null,
      webUrl: suggestion.accountId
        ? crmPath(ctx.workspaceId, `/leads/accounts/${suggestion.accountId}?view=suggestions`)
        : crmPath(ctx.workspaceId, "/leads/suggestions"),
    },
  };
}
