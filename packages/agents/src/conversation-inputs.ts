import type { ConversationTurn } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { AppError, buildRoleOnboardingContextWithLineageForConversation, createConversationPromptInput, createConversationIngressInput } from "@corgtex/domain";
import { createConversationLineageCollector } from "./conversation-lineage";
import type { ConversationPageContext } from "./page-context";

export type ConversationInputCollector = ReturnType<typeof createConversationLineageCollector>;

/** Browser context supplies selection intent only. Every field sent to the model comes from current SQL. */
export async function admitConversationPageContext(actor: AppActor, workspaceId: string,
  input: ConversationPageContext | null | undefined, collector: ConversationInputCollector): Promise<ConversationPageContext | null> {
  if (!input) return null;
  if (input.surface === "context-map") {
    const view = await prisma.contextMapView.findFirst({ where: { id: input.mapView.id, workspaceId } });
    const views = await collector.admitRecords("ContextMapView", view ? [view] : []);
    if (!views.length) return null;
    const rows = await prisma.contextGraphObject.findMany({ where: { workspaceId, id: { in: input.selectedObjectIds } } });
    const objects = await collector.admitRecords("ContextGraphObject", rows);
    const relationships = input.selectedRelationship ? await prisma.contextGraphRelationship.findMany({ where: {
      workspaceId, id: input.selectedRelationship.id,
      sourceObjectId: { in: objects.map((row) => row.id) }, targetObjectId: { in: objects.map((row) => row.id) },
    } }) : [];
    const safeRelationships = await collector.admitRecords("ContextGraphRelationship", relationships);
    const relationship = safeRelationships[0];
    return {
      surface: "context-map", route: null, mapView: { id: views[0].id, name: views[0].name, viewType: views[0].viewType },
      includeStale: input.includeStale, selectedObjectIds: objects.map((row) => row.id),
      selectedObjects: objects.map((row) => ({ id: row.id, title: row.title, objectType: row.objectType, status: row.status })),
      selectedRelationship: relationship ? { id: relationship.id, sourceObjectId: relationship.sourceObjectId,
        targetObjectId: relationship.targetObjectId, relationshipType: relationship.relationshipType, status: relationship.status } : null,
    };
  }
  if (input.workspaceId !== workspaceId) return null;
  const selectedIds = { accountId: null, contactId: null, dealId: null, activityId: null, suggestionId: null } as typeof input.selectedIds;
  const visibleContext: typeof input.visibleContext = { metrics: [], accounts: [], contacts: [], deals: [], activities: [], suggestions: [] };
  const families = [
    ["accounts", "accountId", "CrmAccount", prisma.crmAccount],
    ["contacts", "contactId", "CrmContact", prisma.crmContact],
    ["deals", "dealId", "CrmDeal", prisma.crmDeal],
    ["activities", "activityId", "CrmActivity", prisma.crmActivity],
    ["suggestions", "suggestionId", "CrmCommunicationSuggestion", prisma.crmCommunicationSuggestion],
  ] as const;
  for (const [family, selected, kind, delegate] of families) {
    const ids = [...new Set([input.selectedIds[selected], ...input.visibleContext[family].map((row) => row.id)]
      .filter((id): id is string => typeof id === "string"))].slice(0, 50);
    const rows = await (delegate.findMany as (args: unknown) => Promise<Array<{ id: string; [key: string]: unknown }>>)({ where: { workspaceId, id: { in: ids } } });
    const admitted = await collector.admitRecords(kind, rows);
    selectedIds[selected] = admitted.some((row) => row.id === input.selectedIds[selected]) ? input.selectedIds[selected] : null;
    visibleContext[family] = admitted.map((row) => Object.fromEntries(["id", "name", "title", "company", "status", "type", "stage", "accountId", "contactId", "dealId", "dueAt", "completedAt", "email", "website"]
      .filter((key) => key in row).map((key) => [key, row[key] instanceof Date ? row[key].toISOString() : row[key]])
      .filter(([, value]) => value === null || typeof value === "string" || typeof value === "number")));
  }
  return { surface: "crm", route: null, workspaceId, view: ["accounts", "contacts", "deals", "activity", "suggestions"].includes(input.view) ? input.view : "accounts",
    section: null, selectedIds, filters: {}, pagination: { page: null, pageCount: null, total: null }, visibleContext };
}

export async function prepareConversationInputs(params: { actor: AppActor; workspaceId: string; sessionId: string; userId: string; userMessage: string;
  pageContext?: ConversationPageContext | null; systemPrompt?: string | null; requestSource?: "MCP"; promptInputId?: string; ingressInputId?: string }) {
  if (params.actor.kind === "user" && params.actor.user.id !== params.userId) throw new AppError(403, "FORBIDDEN", "Conversation requester does not match the authenticated actor.");
  const collector = createConversationLineageCollector(params.actor, params.workspaceId);
  if (params.requestSource === "MCP" || params.actor.kind === "agent") {
    const ingress = params.ingressInputId ? await prisma.conversationIngressInput.findFirst({ where: {
      id: params.ingressInputId, workspaceId: params.workspaceId, content: params.userMessage,
    } }) : await createConversationIngressInput(params.actor, { workspaceId: params.workspaceId, content: params.userMessage });
    if (!ingress) throw new AppError(409, "SOURCE_CHANGED", "The admitted conversation input does not match this request.");
    await collector.capture(params.userMessage, [{ kind: "ConversationIngressInput", id: ingress.id, snapshot: ingress }]);
    // MCP has no user conversation history or caller-provided system context.
    return { collector, requestLineageRoots: await collector.roots(), promptInputId: undefined, ingressInputId: ingress.id, pageContext: null, systemPrompt: null };
  }
  if (params.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Conversation requester requires a persisted user session.");
  const prompt = params.promptInputId ? await prisma.conversationPromptInput.findFirst({ where: {
    id: params.promptInputId, workspaceId: params.workspaceId, sessionId: params.sessionId,
    userId: params.actor.user.id, content: params.userMessage,
  } }) : await createConversationPromptInput(params.actor, { workspaceId: params.workspaceId, conversationId: params.sessionId, content: params.userMessage });
  if (!prompt) throw new AppError(409, "SOURCE_CHANGED", "The admitted conversation prompt does not match this request.");
  await collector.capture(params.userMessage, [{ kind: "ConversationPromptInput", id: prompt.id, snapshot: prompt }]);
  const requestLineageRoots = await collector.roots();
  const pageContext = await admitConversationPageContext(params.actor, params.workspaceId, params.pageContext, collector);
  let systemPrompt: string | null = null;
  if (params.systemPrompt) {
    const session = await prisma.conversationSession.findFirst({ where: { id: params.sessionId, workspaceId: params.workspaceId, userId: params.userId } });
    if (session?.systemPrompt === params.systemPrompt && (await collector.admitRecords("ConversationSession", [session])).length) systemPrompt = session.systemPrompt;
  }
  return { collector, requestLineageRoots, promptInputId: prompt.id, pageContext, systemPrompt };
}

export async function loadConversationHistory(actor: AppActor, workspaceId: string, sessionId: string, limit: number, collector: ConversationInputCollector) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new AppError(400, "INVALID_INPUT", "Invalid conversation history size.");
  const permitted: ConversationTurn[] = [];
  let after: { sequenceNumber: number; id: string } | undefined;
  let examined = 0;
  const candidateLimit = Math.max(200, limit);
  while (permitted.length < limit) {
    if (examined >= candidateLimit) {
      await collector.assertReadable();
      throw new AppError(409, "SOURCE_READ_SCAN_LIMIT", "Recent conversation history is unavailable within the candidate window.");
    }
    const take = Math.min(100, candidateLimit - examined);
    const rows = await prisma.conversationTurn.findMany({ where: {
      conversationId: sessionId, conversation: { workspaceId, userId: actor.kind === "user" ? actor.user.id : "" },
      ...(after ? { OR: [{ sequenceNumber: { lt: after.sequenceNumber } }, { sequenceNumber: after.sequenceNumber, id: { lt: after.id } }] } : {}),
    }, orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }], take });
    if (rows.length > take) throw new AppError(409, "SOURCE_CHANGED", "Conversation history page exceeded its bound.");
    examined += rows.length;
    const last = rows.at(-1);
    // Freeze the raw cursor before authorization awaits; denied rows still advance it.
    const next = last ? { sequenceNumber: last.sequenceNumber, id: last.id } : undefined;
    for (const row of rows) {
      permitted.push(...await collector.admitRecords("ConversationTurn", [row]));
      if (permitted.length === limit) break;
    }
    if (rows.length < take) break;
    if (next?.id === after?.id) throw new AppError(409, "SOURCE_CHANGED", "Conversation history changed during pagination.");
    after = next;
  }
  // Only consumed turns enter the collector; its original receipts also fence
  // earlier admitted pages against changes during later authorization awaits.
  await collector.assertReadable();
  return permitted.reverse();
}

export async function loadConversationOnboarding(workspaceId: string, conversationId: string, userId: string, collector: ConversationInputCollector) {
  const context = await buildRoleOnboardingContextWithLineageForConversation({ workspaceId, conversationId, userId });
  if (!context) return null;
  await collector.captureTrusted(context.context, context.lineageRoots);
  return context.context;
}
