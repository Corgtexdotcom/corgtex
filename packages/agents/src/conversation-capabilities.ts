import { agentHasOperation, requireAgentOperation, requireScopedOperation, requireWorkspaceOperation, scopedHasOperation } from "@corgtex/domain";
import type { McpToolName } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
import type { KnowledgeAccessDomain } from "@prisma/client";

// Native conversation tools must declare their own authority. A chat operation
// grants no implicit permission to any tool the model selects inside that chat.
export const CONVERSATION_TOOL_CAPABILITIES = {
  check_calendar_availability: null,
  schedule_meeting: null,
  create_corgtex_scheduled_meeting: ["create_scheduled_meeting"],
  upload_meeting_transcript: ["upload_meeting"],
  search_brain: ["search_knowledge"],
  get_workspace_overview: [
    "get_workspace_info", "list_circles", "list_members", "list_actions",
    "list_tensions", "list_proposals", "list_goals",
  ],
  query_tensions: ["list_tensions"],
  query_actions: ["list_actions"],
  query_proposals: ["list_proposals"],
  query_goals: ["list_goals"],
  // Governance role assignments and raw member audit history lack MCP policies.
  query_org_structure: null,
  get_member_profile: null,
  assign_role: null,
  unassign_role: null,
  // This ingestion tool can create both a document and its indexed Brain source.
  save_to_brain: null,
  create_tension: ["create_tension"],
  update_tension: ["update_tension"],
  create_action: ["create_action"],
  update_action: ["update_action"],
  create_proposal: ["create_proposal"],
  create_goal: ["create_goal"],
  list_members: ["list_members"],
  update_member: ["update_member"],
  list_tool_links: ["list_tool_links"],
  upsert_tool_link: ["upsert_tool_link"],
  archive_tool_link: ["archive_tool_link"],
  reveal_tool_link_credential: ["reveal_tool_link_credential"],
  list_connected_tools: ["list_connected_tools"],
  // Provider-only search is available without Brain authority. Argument-time
  // authorization adds Brain read when the handler includes Corgtex content.
  search_connected_context: ["search_connected_context"],
  fetch_connected_context: ["fetch_connected_context"],
  execute_external_tool: ["execute_external_tool"],
  list_due_relationship_work: ["list_due_relationship_work"],
  record_relationship_activity: ["record_relationship_activity"],
  complete_relationship_activity: ["complete_relationship_activity"],
  create_communication_suggestion: ["create_communication_suggestion"],
  get_context_map_info: ["query_context_graph"],
  get_selected_context_map_region: ["get_selected_region_context"],
  create_context_map_diff: ["create_context_graph_proposed_diff"],
  // Both checks precede creating the diff, including its pending fallback.
  apply_context_map_diff: ["create_context_graph_proposed_diff", "import_context_graph_map"],
} as const satisfies Readonly<Record<string, readonly McpToolName[] | null>>;

function operationsForTool(toolName: string): readonly McpToolName[] | null {
  return Object.prototype.hasOwnProperty.call(CONVERSATION_TOOL_CAPABILITIES, toolName)
    ? CONVERSATION_TOOL_CAPABILITIES[toolName as keyof typeof CONVERSATION_TOOL_CAPABILITIES]
    : null;
}

export function canUseConversationTool(actor: AppActor, toolName: string, operationScopes?: readonly string[]): boolean {
  const operations = operationsForTool(toolName);
  if (operationScopes !== undefined && (operations === null || !operations.every(operation => scopedHasOperation(operation, operationScopes)))) return false;
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return true;
  return operations !== null && operations.every(operation => agentHasOperation(actor, operation));
}

export async function authorizeConversationTurn(actor: AppActor, workspaceId: string, operationScopes?: readonly string[]): Promise<void> {
  if (operationScopes !== undefined) requireScopedOperation("chat", operationScopes);
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return;
  await requireWorkspaceOperation({ actor, workspaceId, operation: "chat" });
}

export async function authorizeConversationKnowledge(actor: AppActor, workspaceId: string, operationScopes?: readonly string[]): Promise<boolean> {
  if (operationScopes !== undefined && !scopedHasOperation("search_knowledge", operationScopes)) return false;
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return true;
  if (!agentHasOperation(actor, "search_knowledge")) return false;
  await requireWorkspaceOperation({ actor, workspaceId, operation: "search_knowledge" });
  return true;
}

export async function filterConversationKnowledgeDomains(
  actor: AppActor,
  workspaceId: string,
  domains: readonly KnowledgeAccessDomain[],
  operationScopes?: readonly string[],
): Promise<KnowledgeAccessDomain[]> {
  if (!domains.includes("FINANCE")) return [...domains];
  const operation = "get_finance_readiness";
  const isCredential = actor.kind === "agent" && actor.authProvider === "credential";
  if ((operationScopes !== undefined && !scopedHasOperation(operation, operationScopes))
    || (isCredential && !agentHasOperation(actor, operation))) {
    return domains.filter(domain => domain !== "FINANCE");
  }
  // Role-resolved domains remain the upper bound for humans. Cached credential
  // Finance scopes also require a current grant before the indexed query runs.
  if (isCredential) await requireWorkspaceOperation({ actor, workspaceId, operation });
  return [...domains];
}

export async function authorizeConversationPageContext(actor: AppActor, workspaceId: string, surface: "crm" | "context-map", operationScopes?: readonly string[]): Promise<void> {
  const operation = surface === "crm" ? "get_relationship_account" : "get_selected_region_context";
  if (operationScopes !== undefined) requireScopedOperation(operation, operationScopes);
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return;
  await requireWorkspaceOperation({
    actor, workspaceId, operation,
  });
}

export async function authorizeConversationTool(actor: AppActor, workspaceId: string, toolName: string, args?: unknown, operationScopes?: readonly string[]): Promise<void> {
  const isCredential = actor.kind === "agent" && actor.authProvider === "credential";
  if (!isCredential && operationScopes === undefined) return;
  const declared = operationsForTool(toolName);
  if (!declared) {
    if (operationScopes !== undefined) requireScopedOperation(`conversation:${toolName}`, operationScopes);
    requireAgentOperation(actor, `conversation:${toolName}`);
    return;
  }
  const operations: McpToolName[] = [...declared];
  if (toolName === "search_connected_context") {
    const providerOnly = args && typeof args === "object" && !Array.isArray(args)
      && (args as Record<string, unknown>).includeCorgtex === false;
    if (!providerOnly) operations.push("search_knowledge");
  }
  if (toolName === "create_proposal" && args && typeof args === "object" && !Array.isArray(args)) {
    const proposalArgs = args as Record<string, unknown>;
    if (typeof proposalArgs.sourceTensionId === "string" && proposalArgs.sourceTensionId.trim()) operations.push("list_tensions");
    if (Array.isArray(proposalArgs.relatedActionIds) && proposalArgs.relatedActionIds.length > 0) operations.push("list_actions");
  }
  if (operationScopes !== undefined) {
    for (const operation of operations) requireScopedOperation(operation, operationScopes);
  }
  if (!isCredential) return;
  // Check every cached scope first, then revalidate every operation against the
  // current workspace credential/support grant before the handler can read/write.
  for (const operation of operations) requireAgentOperation(actor, operation);
  for (const operation of operations) await requireWorkspaceOperation({ actor, workspaceId, operation });
}

type ConversationToolContext = { workspaceId: string; operationScopes?: readonly string[] };
type ConversationToolHandler<TCtx extends ConversationToolContext> = (actor: AppActor, ctx: TCtx, args: any) => Promise<unknown>;

export function guardConversationToolHandlers<
  TCtx extends ConversationToolContext,
  THandlers extends Partial<Record<string, ConversationToolHandler<TCtx>>> = Partial<Record<string, ConversationToolHandler<TCtx>>>,
>(handlers: THandlers & Partial<Record<string, ConversationToolHandler<TCtx>>>): THandlers {
  const guarded = Object.assign(Object.create(null), handlers) as THandlers;
  for (const [toolName, handler] of Object.entries(handlers)) {
    if (typeof handler !== "function") continue;
    const wrapped = async (actor: AppActor, ctx: TCtx, args: unknown) => {
      await authorizeConversationTool(actor, ctx.workspaceId, toolName, args, ctx.operationScopes);
      return handler(actor, ctx, args);
    };
    (guarded as Partial<Record<string, ConversationToolHandler<TCtx>>>)[toolName] = wrapped;
  }
  return guarded;
}
