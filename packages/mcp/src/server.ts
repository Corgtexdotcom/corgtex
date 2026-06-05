// @ts-nocheck
/**
 * Corgtex MCP server — every workspace operation Claude/ChatGPT/Cursor can perform.
 *
 * Convention for tools:
 *   - Every list tool takes { take?, skip? } where applicable.
 *   - Every get tool returns the full record.
 *   - Every write tool returns { id, status?, webUrl } via `jsonResult()`
 *     so Claude can reliably extract a deep-link to show the user.
 *
 * If you add a tool that needs a new scope, also add it to SCOPE_REGISTRY in
 * packages/domain/src/agent-auth.ts — the drift-fence test in scopes.test.ts
 * will fail otherwise.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listProposals,
  archiveWorkspaceArtifact,
  createProposal,
  updateProposal,
  resolveProposal,
  archiveProposal,
  submitProposal,
  publishProposal,
  returnProposalToDraft,
  supportReopenResolvedProposals,
  listActions,
  createAction,
  updateAction,
  returnActionToDraft,
  deleteAction,
  listTensions,
  createTension,
  updateTension,
  returnTensionToDraft,
  deleteTension,
  upvoteTension,
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  returnGoalToDraft,
  deleteGoal,
  listMembers,
  listMembersEnriched,
  createMember,
  updateMember,
  deactivateMember,
  resendMemberAccessLink,
  sendMemberSetupEmail,
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS,
  createDocument,
  listMeetings,
  getMeeting,
  createMeeting,
  intakeMeetingTranscript,
  deleteMeeting,
  createArticle,
  updateArticle,
  getArticle,
  listArticles,
  deleteArticle,
  publishArticle,
  returnArticleToDraft,
  createDiscussionThread,
  addDiscussionComment,
  resolveDiscussionThread,
  listCycles,
  createCycle,
  updateCycle,
  getCycle,
  listCycleUpdates,
  listAllocations,
  listCircles,
  getCurrentConstitution,
  listPolicyCorpus,
  getApprovalPolicies,
  createSpend,
  deleteLedgerAccount,
  deleteSpend,
  submitSpend,
  updateSpend,
  returnSpendToDraft,
  listSpends,
  listLedgerAccounts,
  listArchivedWorkspaceArtifacts,
  listAgentRuns,
  listAgentCredentials,
  updateAgentCredentialScopes,
  revokeAgentCredential,
  listAgentConfigs,
  updateAgentConfig,
  getModelUsageBudget,
  updateModelUsageBudget,
  listCommunicationInstallations,
  listExternalDataSources,
  enqueueExternalDataSourceSync,
  archiveWorkspaceToolLink,
  getAppConnectionInstructions,
  getAppRoutingGuidance,
  listInstalledApps,
  listWorkspaceToolLinks,
  requestAppInstall,
  revealWorkspaceToolLinkCredential,
  upsertWorkspaceToolLink,
  listRuntimeJobs,
  listFailedJobs,
  replayWorkflowJob,
  discardFailedJob,
  purgeWorkspaceArtifact,
  restoreWorkspaceArtifact,
  evaluateDelegatedActionPolicy,
  executeExternalMcpTool,
  fetchConnectedExternalMcpContext,
  listExternalMcpConnections,
  recordAudit,
  searchConnectedExternalMcpContext,
  buildSelectedRegionContext,
  createContextGraphProposedDiff,
  importContextGraphMap,
  getContextMapData,
  createExecutionRequest,
  getExecutionPacket,
  getCompanyContext,
  listWritebackTargets,
  submitExecutionResult,
  listWorkItemVersions,
  getWorkItemVersion,
} from "@corgtex/domain";
import type { AgentScope } from "@corgtex/domain";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { processConversationTurn } from "@corgtex/agents";
import { prisma, env, toInputJson } from "@corgtex/shared";
import type { McpSessionContext } from "./auth";
import { requireScope } from "./auth";

/**
 * Build a deep-link to a workspace resource. Used for `webUrl` in write-tool
 * results so Claude can tell the user "open this to inspect/edit" without
 * having to construct URLs from a workspace slug.
 */
function webUrl(workspaceId: string, path: string): string {
  const origin = env.APP_URL.replace(/\/$/, "");
  return `${origin}/workspaces/${workspaceId}${path}`;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function structuredJsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function agentCredentialSummary(credential: {
  id: string;
  label: string;
  scopes: string[];
  catalogItemId?: string | null;
  monthlyBudgetCents?: number | null;
  dailyCallLimit?: number | null;
  isActive: boolean;
  lastUsedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    id: credential.id,
    label: credential.label,
    scopes: credential.scopes,
    catalogItemId: credential.catalogItemId ?? null,
    monthlyBudgetCents: credential.monthlyBudgetCents ?? null,
    dailyCallLimit: credential.dailyCallLimit ?? null,
    isActive: credential.isActive,
    lastUsedAt: credential.lastUsedAt ?? null,
    createdAt: credential.createdAt ?? null,
    updatedAt: credential.updatedAt ?? null,
  };
}

const DESTRUCTIVE_TOOL_NAMES = new Set([
  "purge_artifact",
  "revoke_agent_credential",
]);

type ToolCapability = {
  scopes: AgentScope[];
  destructive?: boolean;
  sensitive?: boolean;
};

const TOOL_CAPABILITIES = {
  chat: { scopes: ["conversations:write"] },
  search_knowledge: { scopes: ["brain:read"] },
  query_context_graph: { scopes: ["context-graph:read"] },
  get_context_neighbors: { scopes: ["context-graph:read"] },
  get_context_evidence: { scopes: ["context-graph:read"] },
  get_selected_region_context: { scopes: ["context-graph:read"] },
  create_context_graph_proposed_diff: { scopes: ["context-graph:propose"] },
  import_context_graph_map: { scopes: ["context-graph:approve"], sensitive: true },
  search: { scopes: ["brain:read"] },
  fetch: { scopes: ["brain:read"] },
  list_connected_tools: { scopes: ["external-tools:read"] },
  list_installed_apps: { scopes: ["tools:read"] },
  get_app_routing_guidance: { scopes: ["tools:read"] },
  get_app_connection_instructions: { scopes: ["tools:read"] },
  request_app_install: { scopes: ["tools:write"] },
  search_connected_context: { scopes: ["external-tools:read"] },
  fetch_connected_context: { scopes: ["external-tools:read"] },
  execute_external_tool: { scopes: ["external-tools:write"] },
  get_workspace_info: { scopes: ["workspace:read"] },
  daily_overview: { scopes: ["workspace:read", "actions:read", "proposals:read", "tensions:read", "meetings:read", "finance:read"] },
  create_execution_request: { scopes: ["execution:write"] },
  get_execution_packet: { scopes: ["execution:read"] },
  get_company_context: { scopes: ["execution:read", "workspace:read", "actions:read", "tensions:read", "proposals:read", "meetings:read", "brain:read"] },
  list_writeback_targets: { scopes: ["execution:read"] },
  submit_execution_result: { scopes: ["execution:write"] },
  record_support_audit: { scopes: ["support:write"], sensitive: true },
  list_integrations: { scopes: ["integrations:read"] },
  list_data_sources: { scopes: ["data-sources:read"] },
  sync_data_source: { scopes: ["data-sources:write"] },
  list_tool_links: { scopes: ["tools:read"] },
  upsert_tool_link: { scopes: ["tools:write"] },
  reveal_tool_link_credential: { scopes: ["tools:credentials:read"], sensitive: true },
  archive_tool_link: { scopes: ["tools:write"] },
  list_agent_runs: { scopes: ["agents:read"] },
  list_agent_credentials: { scopes: ["agents:read"] },
  update_agent_credential_scopes: { scopes: ["support:write"], sensitive: true },
  revoke_agent_credential: { scopes: ["support:write"], destructive: true, sensitive: true },
  list_agent_configs: { scopes: ["agents:read"] },
  update_agent_policy: { scopes: ["support:write"], sensitive: true },
  get_model_budget: { scopes: ["agents:read"] },
  update_model_budget: { scopes: ["support:write"], sensitive: true },
  list_runtime_jobs: { scopes: ["runtime:read"] },
  list_failed_jobs: { scopes: ["runtime:read"] },
  retry_failed_job: { scopes: ["runtime:write"] },
  discard_failed_job: { scopes: ["runtime:write"] },
  upload_document_text: { scopes: ["documents:write"] },
  list_proposals: { scopes: ["proposals:read"] },
  get_proposal: { scopes: ["proposals:read"] },
  create_proposal: { scopes: ["proposals:write"] },
  update_proposal: { scopes: ["proposals:write"] },
  resolve_proposal: { scopes: ["proposals:write"] },
  submit_proposal: { scopes: ["proposals:write"] },
  archive_proposal: { scopes: ["proposals:write"] },
  publish_proposal: { scopes: ["proposals:write"] },
  return_proposal_to_draft: { scopes: ["proposals:write"] },
  support_reopen_resolved_proposals: { scopes: ["support:write", "proposals:write"], sensitive: true },
  list_actions: { scopes: ["actions:read"] },
  create_action: { scopes: ["actions:write"] },
  update_action: { scopes: ["actions:write"] },
  complete_action: { scopes: ["actions:write"] },
  return_action_to_draft: { scopes: ["actions:write"] },
  delete_action: { scopes: ["actions:write"] },
  list_tensions: { scopes: ["tensions:read"] },
  create_tension: { scopes: ["tensions:write"] },
  update_tension: { scopes: ["tensions:write"] },
  return_tension_to_draft: { scopes: ["tensions:write"] },
  upvote_tension: { scopes: ["tensions:write"] },
  delete_tension: { scopes: ["tensions:write"] },
  list_goals: { scopes: ["goals:read"] },
  get_goal: { scopes: ["goals:read"] },
  create_goal: { scopes: ["goals:write"] },
  update_goal: { scopes: ["goals:write"] },
  return_goal_to_draft: { scopes: ["goals:write"] },
  archive_goal: { scopes: ["goals:write"] },
  list_members: { scopes: ["members:read"] },
  create_member: { scopes: ["members:write"] },
  update_member: { scopes: ["members:write"] },
  deactivate_member: { scopes: ["members:write"] },
  resend_member_access_link: { scopes: ["members:write"] },
  list_feature_flags: { scopes: ["workspace:read"] },
  set_feature_flag: { scopes: ["workspace:write"] },
  list_meetings: { scopes: ["meetings:read"] },
  get_meeting: { scopes: ["meetings:read"] },
  upload_meeting: { scopes: ["meetings:write"] },
  delete_meeting: { scopes: ["meetings:write"] },
  list_articles: { scopes: ["brain:read"] },
  get_article: { scopes: ["brain:read"] },
  create_article: { scopes: ["brain:write"] },
  update_article: { scopes: ["brain:write"] },
  delete_article: { scopes: ["brain:write"] },
  publish_article: { scopes: ["brain:write"] },
  return_article_to_draft: { scopes: ["brain:write"] },
  create_discussion_thread: { scopes: ["brain:write"] },
  add_discussion_comment: { scopes: ["brain:write"] },
  resolve_discussion: { scopes: ["brain:write"] },
  list_cycles: { scopes: ["cycles:read"] },
  get_cycle: { scopes: ["cycles:read"] },
  list_cycle_updates: { scopes: ["cycles:read"] },
  list_allocations: { scopes: ["cycles:read"] },
  create_cycle: { scopes: ["cycles:write"] },
  update_cycle: { scopes: ["cycles:write"] },
  list_circles: { scopes: ["circles:read"] },
  get_constitution: { scopes: ["governance:read"] },
  list_policies: { scopes: ["governance:read"] },
  list_approval_policies: { scopes: ["governance:read"] },
  list_spends: { scopes: ["finance:read"] },
  create_spend: { scopes: ["finance:write"] },
  create_spend_draft: { scopes: ["finance:write"] },
  submit_spend: { scopes: ["finance:write"] },
  update_spend: { scopes: ["finance:write"] },
  return_spend_to_draft: { scopes: ["finance:write"] },
  archive_spend: { scopes: ["finance:write"] },
  list_ledger_accounts: { scopes: ["finance:read"] },
  archive_ledger_account: { scopes: ["finance:write"] },
  archive_artifact: { scopes: ["archive:write"] },
  list_archived_artifacts: { scopes: ["archive:read"] },
  restore_artifact: { scopes: ["archive:write"] },
  purge_artifact: { scopes: ["archive:write"], destructive: true },
  list_ledger_transactions: { scopes: ["finance:read"] },
  list_work_item_versions: { scopes: [] },
  get_work_item_version: { scopes: [] },
} satisfies Record<string, ToolCapability>;

const MUTATING_READ_PREFIX_TOOLS = new Set(["get_execution_packet"]);

function summarizeForExecutionAudit(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).sort(),
    };
  }
  return { type: typeof value };
}

function annotationsForTool(name: string) {
  const readOnlyHint = /^(search|fetch|list_|get_|daily_overview$)/.test(name) && !MUTATING_READ_PREFIX_TOOLS.has(name);
  const capability = TOOL_CAPABILITIES[name as keyof typeof TOOL_CAPABILITIES];
  const policy = evaluateDelegatedActionPolicy({
    toolName: name,
    operation: readOnlyHint ? "read" : "write",
    explicitUserIntent: true,
  });
  const destructiveHint = DESTRUCTIVE_TOOL_NAMES.has(name) || Boolean(capability?.destructive);
  const sensitiveHint = Boolean(capability?.sensitive) || policy.requiresSensitiveHandling;
  const openWorldHint = name === "list_connected_tools"
    || name === "list_installed_apps"
    || name === "get_app_routing_guidance"
    || name === "get_app_connection_instructions"
    || name === "request_app_install"
    || name === "search_connected_context"
    || name === "fetch_connected_context"
    || name === "execute_external_tool";
  return {
    title: name
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    readOnlyHint,
    destructiveHint,
    sensitiveHint,
    idempotentHint: readOnlyHint,
    openWorldHint,
  };
}

const PROPOSAL_STATUS = ["DRAFT", "OPEN", "RESOLVED"] as const;
const ACTION_STATUS = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const;
const TENSION_STATUS = ["DRAFT", "OPEN", "RESOLVED"] as const;
const ARCHIVE_FILTER = ["active", "archived", "all"] as const;
const GOAL_CADENCE = ["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "FIVE_YEAR", "TEN_YEAR"] as const;
const GOAL_STATUS = ["DRAFT", "ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "ABANDONED"] as const;
const GOAL_LEVEL = ["COMPANY", "CIRCLE", "PERSONAL"] as const;
const MEMBER_ROLE = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"] as const;
const CYCLE_STATUS = ["PLANNED", "OPEN_UPDATES", "OPEN_ALLOCATIONS", "REVIEW", "FINALIZED"] as const;
const BRAIN_ARTICLE_TYPE = [
  "PRODUCT", "ARCHITECTURE", "PROCESS", "RUNBOOK", "DECISION",
  "TEAM", "PERSON", "CUSTOMER", "INCIDENT", "PROJECT",
  "INTEGRATION", "PATTERN", "STRATEGY", "CULTURE", "GLOSSARY", "DIGEST",
] as const;
const BRAIN_ARTICLE_AUTHORITY = ["AUTHORITATIVE", "REFERENCE", "HISTORICAL", "DRAFT"] as const;
const BRAIN_DISCUSSION_TARGET = ["ARTICLE", "SECTION", "LINE"] as const;
const WORK_ITEM_ENTITY_TYPE = ["TENSION", "PROPOSAL", "ACTION", "SPEND", "GOAL"] as const;

/**
 * Create and configure a new McpServer instance with all Corgtex tools and resources.
 *
 * Each tool/resource handler receives a `sessionCtx` via closure — this is set per-request
 * by the HTTP transport layer after authentication.
 */
export function createCorgtexMcpServer(sessionCtx: McpSessionContext): McpServer {
  const server = new McpServer({
    name: "corgtex",
    version: "1.0.0",
  });

  const { actor, workspaceId } = sessionCtx;
  const sessionActorId = actor.kind === "user"
    ? actor.user.id
    : actor.credentialId ?? actor.agentIdentityId ?? actor.label ?? actor.authProvider;
  const hasToolCapability = (name: string): name is keyof typeof TOOL_CAPABILITIES =>
    Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, name);
  const requireToolCapability = (name: keyof typeof TOOL_CAPABILITIES) => {
    for (const scope of TOOL_CAPABILITIES[name].scopes) {
      requireScope(sessionCtx, scope);
    }
  };
  const requireWorkItemVersionReadScope = (entityType: typeof WORK_ITEM_ENTITY_TYPE[number]) => {
    const scopeByEntity = {
      TENSION: "tensions:read",
      PROPOSAL: "proposals:read",
      ACTION: "actions:read",
      SPEND: "finance:read",
      GOAL: "goals:read",
    } as const;
    requireScope(sessionCtx, scopeByEntity[entityType]);
  };
  const auditToolExecution = async (name: string, input: unknown, result: unknown, error?: unknown) => {
    if (!hasToolCapability(name) || name === "record_support_audit") return;
    const annotation = annotationsForTool(name);
    if (annotation.readOnlyHint) return;

    const policy = evaluateDelegatedActionPolicy({
      toolName: name,
      operation: "write",
      explicitUserIntent: true,
    });
    if (policy.policyClass === "read") return;

    try {
      await prisma.$transaction(async (tx) => {
        await recordAudit(tx, actor, {
          workspaceId,
          action: "mcp.tool_executed",
          entityType: "McpTool",
          entityId: name,
          meta: {
            provider: "corgtex",
            toolName: name,
            policyClass: policy.policyClass,
            confidence: null,
            inputSummary: summarizeForExecutionAudit(input),
            resultSummary: error ? null : summarizeForExecutionAudit(result),
            error: error instanceof Error ? error.message : error ? String(error) : null,
          },
        });
      });
    } catch {
      // Execution audit is best-effort; domain permission checks and tool work
      // must not fail because audit storage had a transient problem.
    }
  };
  const tool = (name: string, description: string, inputSchema: Record<string, unknown>, handler: unknown) => {
    const guardedHandler = typeof handler === "function" && hasToolCapability(name)
      ? async (...args: unknown[]) => {
        requireToolCapability(name);
        try {
          const result = await handler(...args);
          await auditToolExecution(name, args[0], result);
          return result;
        } catch (error) {
          await auditToolExecution(name, args[0], null, error);
          throw error;
        }
      }
      : handler;
    return server.tool(name, description, inputSchema, annotationsForTool(name), guardedHandler);
  };

  // ===========================================================================
  // CONVERSATION + SEARCH
  // ===========================================================================

  // @ts-expect-error — MCP SDK overload triggers TS2589 with zod schemas
  tool(
    "chat",
    "Send a message to Corgtex, the AI governance assistant. Returns Corgtex's response with full organizational knowledge context. This invokes an LLM call on the server side.",
    {
      message: z.string().describe("The message to send to Corgtex"),
    },
    async ({ message }: { message: string }) => {
      requireScope(sessionCtx, "conversations:write");
      const result = await processConversationTurn({
        workspaceId,
        sessionId: `mcp-${workspaceId}-${sessionActorId}`,
        userId: actor.kind === "user" ? actor.user.id : "",
        agentKey: "assistant",
        userMessage: message,
        actor,
      });
      return jsonResult({ assistantMessage: result.assistantMessage });
    },
  );

  tool(
    "search_knowledge",
    "Search Corgtex's organizational knowledge base (Brain). Returns relevant document chunks from policies, meeting notes, proposals, and other indexed content. Does NOT invoke an LLM — just retrieval.",
    {
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max results to return (default 5)"),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      requireScope(sessionCtx, "brain:read");
      const results = await searchIndexedKnowledge({
        workspaceId,
        query,
        limit: limit ?? 5,
      });
      return jsonResult(results);
    },
  );

  tool(
    "search",
    "Search Corgtex knowledge for ChatGPT, Claude, Cursor, and other MCP clients. Returns fetchable result IDs and short snippets.",
    {
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max results to return (default 5)"),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      requireScope(sessionCtx, "brain:read");
      const results = await searchIndexedKnowledge({
        workspaceId,
        query,
        limit: limit ?? 5,
      });
      const mapped = results.map((result) => ({
        id: result.chunkId,
        title: result.title ?? `${result.sourceType} ${result.sourceId}`,
        text: result.snippet,
        url: webUrl(workspaceId, `/brain?source=${encodeURIComponent(result.sourceId)}`),
        metadata: {
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          chunkIndex: result.chunkIndex,
          score: result.score,
        },
      }));
      return structuredJsonResult({ results: mapped });
    },
  );

  tool(
    "fetch",
    "Fetch the full Corgtex knowledge chunk for a result returned by search.",
    {
      id: z.string().describe("The search result ID returned by the search tool"),
    },
    async ({ id }: { id: string }) => {
      requireScope(sessionCtx, "brain:read");
      const chunk = await prisma.knowledgeChunk.findFirst({
        where: { id, workspaceId },
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          sourceTitle: true,
          chunkIndex: true,
          content: true,
          metadata: true,
          createdAt: true,
        },
      });
      if (!chunk) {
        return structuredJsonResult({ error: "Not found", id });
      }
      return structuredJsonResult({
        id: chunk.id,
        title: chunk.sourceTitle ?? `${chunk.sourceType} ${chunk.sourceId}`,
        text: chunk.content,
        url: webUrl(workspaceId, `/brain?source=${encodeURIComponent(chunk.sourceId)}`),
        metadata: {
          sourceType: chunk.sourceType,
          sourceId: chunk.sourceId,
          chunkIndex: chunk.chunkIndex,
          createdAt: chunk.createdAt,
          raw: chunk.metadata,
        },
      });
    },
  );

  tool(
    "query_context_graph",
    "Query living company context graph objects and relationships. Use this for structured ownership, dependency, status, and provenance context before falling back to broad semantic search.",
    {
      objectType: z.string().optional().describe("Optional object type filter, e.g. Process, Decision, Task, Team"),
      status: z.string().optional().describe("Optional status filter, e.g. approved, proposed, stale, disputed"),
      take: z.number().optional().describe("Max objects to return (default 50, max 100)"),
    },
    async ({ objectType, status, take }: { objectType?: string; status?: string; take?: number }) => {
      requireToolCapability("query_context_graph");
      const limit = Math.min(Math.max(take ?? 50, 1), 100);
      const objects = await prisma.contextGraphObject.findMany({
        where: {
          workspaceId,
          ...(objectType ? { objectType } : {}),
          ...(status ? { status } : { status: { not: "archived" } }),
        },
        orderBy: [{ objectType: "asc" }, { updatedAt: "desc" }],
        take: limit,
      });
      const relationships = await prisma.contextGraphRelationship.findMany({
        where: {
          workspaceId,
          sourceObjectId: { in: objects.map((object) => object.id) },
          targetObjectId: { in: objects.map((object) => object.id) },
          status: { not: "archived" },
        },
        take: limit * 2,
      });
      return structuredJsonResult({ objects, relationships, webUrl: webUrl(workspaceId, "/maps") });
    },
  );

  tool(
    "get_context_neighbors",
    "Get graph neighbors around one context graph object. Returns the selected object, connected relationships, neighboring objects, and evidence refs.",
    {
      objectId: z.string().describe("ContextGraphObject id"),
      depth: z.number().optional().describe("Traversal depth, default 1, max 2"),
      includeStale: z.boolean().optional(),
    },
    async ({ objectId, depth, includeStale }: { objectId: string; depth?: number; includeStale?: boolean }) => {
      requireToolCapability("get_context_neighbors");
      const context = await buildSelectedRegionContext(actor, {
        workspaceId,
        objectIds: [objectId],
        depth: depth ?? 1,
        includeStale,
      });
      return structuredJsonResult({ ...context, webUrl: webUrl(workspaceId, "/maps") });
    },
  );

  tool(
    "get_context_evidence",
    "Get evidence refs attached to a context graph object or relationship.",
    {
      objectId: z.string().optional(),
      relationshipId: z.string().optional(),
      take: z.number().optional().describe("Default 20"),
    },
    async ({ objectId, relationshipId, take }: { objectId?: string; relationshipId?: string; take?: number }) => {
      requireToolCapability("get_context_evidence");
      if (Boolean(objectId) === Boolean(relationshipId)) {
        throw new Error("Provide exactly one of objectId or relationshipId.");
      }
      const evidenceRefs = await prisma.contextGraphEvidenceRef.findMany({
        where: {
          workspaceId,
          ...(objectId ? { objectId } : { relationshipId }),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(take ?? 20, 1), 50),
      });
      return structuredJsonResult({ evidenceRefs });
    },
  );

  tool(
    "get_selected_region_context",
    "Assemble a scoped agent context packet from selected map region object ids: graph neighbors, evidence, temporal scope, stale/disputed facts, and permissions.",
    {
      objectIds: z.array(z.string()).min(1).describe("Selected ContextGraphObject ids"),
      mapViewId: z.string().optional(),
      depth: z.number().optional().describe("Default 2, max 2"),
      includeStale: z.boolean().optional(),
      asOf: z.string().optional().describe("Optional ISO timestamp for temporal context"),
    },
    async ({ objectIds, mapViewId, depth, includeStale, asOf }: {
      objectIds: string[];
      mapViewId?: string;
      depth?: number;
      includeStale?: boolean;
      asOf?: string;
    }) => {
      requireToolCapability("get_selected_region_context");
      const context = await buildSelectedRegionContext(actor, {
        workspaceId,
        mapViewId,
        objectIds,
        depth: depth ?? 2,
        includeStale,
        asOf: asOf ?? null,
      });
      return structuredJsonResult({ ...context, webUrl: webUrl(workspaceId, "/maps") });
    },
  );

  tool(
    "create_context_graph_proposed_diff",
    "Create a proposed diff against the living context graph. This does not mutate approved graph truth; it creates a reviewable proposal for a human or policy gate.",
    {
      reason: z.string().optional(),
      diff: z.record(z.string(), z.any()).describe("Diff JSON with optional objects, relationships, and evidenceRefs arrays"),
      evidence: z.record(z.string(), z.any()).optional(),
    },
    async ({ reason, diff, evidence }: { reason?: string; diff: Record<string, unknown>; evidence?: Record<string, unknown> }) => {
      requireToolCapability("create_context_graph_proposed_diff");
      const proposedDiff = await createContextGraphProposedDiff(actor, {
        workspaceId,
        reason,
        diff,
        evidence,
      });
      return jsonResult({ id: proposedDiff.id, status: proposedDiff.status, webUrl: webUrl(workspaceId, "/maps") });
    },
  );

  tool(
    "import_context_graph_map",
    "Import an approved context graph map with objects, relationships, evidence refs, and layout in one audited operation.",
    {
      name: z.string().describe("Master context map view name"),
      viewType: z.string().optional().describe("Context map view type, default process"),
      query: z.record(z.string(), z.unknown()).optional(),
      objects: z.array(z.record(z.string(), z.any())).min(1),
      relationships: z.array(z.record(z.string(), z.any())).optional(),
      evidenceRefs: z.array(z.record(z.string(), z.any())).optional(),
      layoutItems: z.array(z.record(z.string(), z.any())).optional(),
    },
    async (params: {
      name: string;
      viewType?: string;
      query?: Record<string, unknown>;
      objects: Array<Record<string, unknown>>;
      relationships?: Array<Record<string, unknown>>;
      evidenceRefs?: Array<Record<string, unknown>>;
      layoutItems?: Array<Record<string, unknown>>;
    }) => {
      requireToolCapability("import_context_graph_map");
      const result = await importContextGraphMap(actor, {
        workspaceId,
        name: params.name,
        viewType: params.viewType,
        query: params.query,
        objects: params.objects as any,
        relationships: params.relationships as any,
        evidenceRefs: params.evidenceRefs as any,
        layoutItems: params.layoutItems as any,
      });
      return jsonResult({ ...result, webUrl: webUrl(workspaceId, `/maps?view=${result.mapViewId}`) });
    },
  );

  tool(
    "list_connected_tools",
    "List same-user delegated external MCP tools connected to this workspace, starting with Notion. Does not reveal OAuth tokens.",
    {},
    async () => {
      requireToolCapability("list_connected_tools");
      const tools = await listExternalMcpConnections(actor, workspaceId);
      return structuredJsonResult({ items: tools });
    },
  );

  tool(
    "list_installed_apps",
    "List Corgtex marketplace apps for this workspace, split into installed/approved apps and available apps. Does not proxy app writes.",
    {},
    async () => {
      requireToolCapability("list_installed_apps");
      const apps = await listInstalledApps(actor, { workspaceId });
      return structuredJsonResult({ ...apps, webUrl: webUrl(workspaceId, "/tools?type=APP") });
    },
  );

  tool(
    "get_app_routing_guidance",
    "Ask Corgtex where a user intent should be routed across Corgtex MCP and installed app MCPs. Returns guidance only; it does not write app records.",
    {
      intent: z.string().describe("What the user is trying to save, read, or update."),
      recordType: z.string().optional().describe("Optional record type, such as expense, account statement, proposal, or Brain source."),
    },
    async ({ intent, recordType }: { intent: string; recordType?: string }) => {
      requireToolCapability("get_app_routing_guidance");
      const guidance = await getAppRoutingGuidance(actor, { workspaceId, intent, recordType });
      return structuredJsonResult(guidance as Record<string, unknown>);
    },
  );

  tool(
    "get_app_connection_instructions",
    "Get setup instructions for an installed or available Corgtex marketplace app. Use this before asking a user to connect a separate app MCP.",
    {
      catalogItemId: z.string().optional().describe("Catalog item id from list_installed_apps."),
      appKey: z.string().optional().describe("App key such as practice-ledger."),
    },
    async ({ catalogItemId, appKey }: { catalogItemId?: string; appKey?: string }) => {
      requireToolCapability("get_app_connection_instructions");
      const instructions = await getAppConnectionInstructions(actor, { workspaceId, catalogItemId, appKey });
      return structuredJsonResult({ ...instructions, webUrl: webUrl(workspaceId, `/tools/${instructions.app.id}`) });
    },
  );

  tool(
    "request_app_install",
    "Create a Tools admin request to install an available marketplace app. Does not install or call the app directly.",
    {
      catalogItemId: z.string().optional().describe("Catalog item id from list_installed_apps."),
      appKey: z.string().optional().describe("App key such as practice-ledger."),
      reasonMd: z.string().optional().describe("Why this workspace needs the app."),
    },
    async ({ catalogItemId, appKey, reasonMd }: { catalogItemId?: string; appKey?: string; reasonMd?: string }) => {
      requireToolCapability("request_app_install");
      const result = await requestAppInstall(actor, { workspaceId, catalogItemId, appKey, reasonMd });
      return structuredJsonResult({ ...result, webUrl: webUrl(workspaceId, `/tools/${result.app.id}`) });
    },
  );

  tool(
    "search_connected_context",
    "Search live connected context across Corgtex Brain and same-user external MCP sources such as Notion. External results are not saved into Brain unless the user explicitly asks.",
    {
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max combined results to return (default 5, max 20)"),
      includeCorgtex: z.boolean().optional().describe("Whether to include Corgtex Brain results (default true)"),
      providerKey: z.enum(["notion"]).optional().describe("Limit external search to one connected provider"),
    },
    async ({ query, limit, includeCorgtex, providerKey }: {
      query: string;
      limit?: number;
      includeCorgtex?: boolean;
      providerKey?: "notion";
    }) => {
      requireToolCapability("search_connected_context");
      const safeLimit = Math.max(1, Math.min(limit ?? 5, 20));
      const corgtexResults = [];

      if (includeCorgtex !== false) {
        requireScope(sessionCtx, "brain:read");
        const results = await searchIndexedKnowledge({
          workspaceId,
          query,
          limit: safeLimit,
        });
        corgtexResults.push(...results.map((result) => ({
          id: `corgtex:${result.chunkId}`,
          source: "corgtex",
          providerKey: "corgtex",
          providerDisplayName: "Corgtex Brain",
          externalId: result.chunkId,
          title: result.title ?? `${result.sourceType} ${result.sourceId}`,
          text: result.snippet,
          url: webUrl(workspaceId, `/brain?source=${encodeURIComponent(result.sourceId)}`),
          metadata: {
            sourceType: result.sourceType,
            sourceId: result.sourceId,
            chunkIndex: result.chunkIndex,
            score: result.score,
          },
        })));
      }

      const external = await searchConnectedExternalMcpContext(actor, {
        workspaceId,
        query,
        providerKey,
        limit: safeLimit,
      });

      return structuredJsonResult({
        results: [...corgtexResults, ...external.results].slice(0, safeLimit),
        externalErrors: external.errors,
      });
    },
  );

  tool(
    "fetch_connected_context",
    "Fetch detail for one live external MCP result returned by search_connected_context. Does not ingest the result into Corgtex Brain.",
    {
      providerKey: z.enum(["notion"]).describe("Connected external provider key"),
      externalId: z.string().describe("External result ID to fetch"),
    },
    async ({ providerKey, externalId }: { providerKey: "notion"; externalId: string }) => {
      requireToolCapability("fetch_connected_context");
      const result = await fetchConnectedExternalMcpContext(actor, {
        workspaceId,
        providerKey,
        externalId,
      });
      return structuredJsonResult(result as Record<string, unknown>);
    },
  );

  tool(
    "execute_external_tool",
    "Execute a same-user delegated external MCP tool, such as a Notion tool, under the authenticated user's connected account. Normal writes auto-run when explicit/high-confidence; sensitive Corgtex actions are not routed through this generic gateway.",
    {
      providerKey: z.enum(["notion"]).describe("Connected external provider key"),
      toolName: z.string().describe("External MCP tool name to execute"),
      arguments: z.record(z.string(), z.unknown()).optional().describe("External MCP tool arguments"),
      operation: z.enum(["read", "write"]).optional().describe("External operation class. Unknown tools default to write."),
      confidence: z.number().optional().describe("Model confidence from 0 to 1 when available"),
      explicitUserIntent: z.boolean().optional().describe("True only when the user explicitly asked for this external execution."),
    },
    async ({ providerKey, toolName, arguments: args, operation, confidence, explicitUserIntent }: {
      providerKey: "notion";
      toolName: string;
      arguments?: Record<string, unknown>;
      operation?: "read" | "write";
      confidence?: number;
      explicitUserIntent?: boolean;
    }) => {
      requireToolCapability("execute_external_tool");
      const result = await executeExternalMcpTool(actor, {
        workspaceId,
        providerKey,
        toolName,
        arguments: args ?? {},
        operation,
        confidence,
        explicitUserIntent: explicitUserIntent === true,
      });
      return structuredJsonResult(result as Record<string, unknown>);
    },
  );

  // ===========================================================================
  // WORKSPACE OVERVIEW
  // ===========================================================================

  tool(
    "get_workspace_info",
    "Get basic workspace information including name, description, and aggregate counts.",
    {},
    async () => {
      requireScope(sessionCtx, "workspace:read");
      const [workspace, proposalCount, actionCount, tensionCount, memberCount] = await Promise.all([
        prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { id: true, slug: true, name: true, description: true, createdAt: true },
        }),
        prisma.proposal.count({ where: { workspaceId } }),
        prisma.action.count({ where: { workspaceId } }),
        prisma.tension.count({ where: { workspaceId } }),
        prisma.member.count({ where: { workspaceId, isActive: true } }),
      ]);
      return jsonResult({
        ...workspace,
        webUrl: webUrl(workspaceId, ""),
        counts: { proposals: proposalCount, actions: actionCount, tensions: tensionCount, members: memberCount },
      });
    },
  );

  tool(
    "list_work_item_versions",
    "List previous saved versions for a tension, proposal, action, spend request, or goal. Versions are returned newest first and include the changed fields and previous state snapshot.",
    {
      entityType: z.enum(WORK_ITEM_ENTITY_TYPE).describe("TENSION, PROPOSAL, ACTION, SPEND, or GOAL"),
      entityId: z.string().describe("Work item ID"),
    },
    async ({ entityType, entityId }: { entityType: typeof WORK_ITEM_ENTITY_TYPE[number]; entityId: string }) => {
      requireWorkItemVersionReadScope(entityType);
      const result = await listWorkItemVersions(actor, { workspaceId, entityType, entityId });
      return jsonResult({
        ...result,
        webUrl: webUrl(workspaceId, `/versions?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`),
      });
    },
  );

  tool(
    "get_work_item_version",
    "Fetch one previous saved version snapshot for a tension, proposal, action, spend request, or goal.",
    {
      entityType: z.enum(WORK_ITEM_ENTITY_TYPE).describe("TENSION, PROPOSAL, ACTION, SPEND, or GOAL"),
      entityId: z.string().describe("Work item ID"),
      version: z.number().int().positive().describe("Previous version number to fetch"),
    },
    async ({ entityType, entityId, version }: { entityType: typeof WORK_ITEM_ENTITY_TYPE[number]; entityId: string; version: number }) => {
      requireWorkItemVersionReadScope(entityType);
      const result = await getWorkItemVersion(actor, { workspaceId, entityType, entityId, version });
      return jsonResult(result);
    },
  );

  tool(
    "daily_overview",
    "Get a one-call daily digest of recent workspace activity: open actions, in-flight proposals, fresh tensions, recent meetings, and pending spend requests within a configurable window. Defaults to the last 24 hours.",
    {
      windowHours: z.number().optional().describe("How many hours back to look (default 24)"),
    },
    async ({ windowHours }: { windowHours?: number }) => {
      requireScope(sessionCtx, "workspace:read");
      requireScope(sessionCtx, "actions:read");
      requireScope(sessionCtx, "proposals:read");
      requireScope(sessionCtx, "tensions:read");
      requireScope(sessionCtx, "meetings:read");
      requireScope(sessionCtx, "finance:read");
      const since = new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);

      const [actions, proposals, tensions, meetings, spends] = await Promise.all([
        listActions(actor, workspaceId, { take: 100 }),
        listProposals(actor, workspaceId, { take: 50 }),
        listTensions(actor, workspaceId, { take: 50 }),
        listMeetings(workspaceId),
        listSpends(actor, workspaceId, { take: 50 }),
      ]);

      const recentActions = actions.items
        .filter((a) => a.status !== "COMPLETED")
        .map((a) => ({
          id: a.id,
          title: a.title,
          status: a.status,
          assignee: a.assigneeMember?.user?.displayName ?? a.assigneeMember?.user?.email ?? null,
          dueAt: (a as Record<string, unknown>).dueAt ?? null,
          createdAt: a.createdAt,
        }));

      const inFlightProposals = proposals.items
        .filter((p) => p.status === "DRAFT" || p.status === "OPEN")
        .map((p) => ({ id: p.id, title: p.title, status: p.status, resolutionOutcome: p.resolutionOutcome, createdAt: p.createdAt }));

      const freshTensions = tensions.items
        .filter((t) => new Date(t.createdAt) >= since || t.status === "OPEN")
        .slice(0, 20)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, createdAt: t.createdAt }));

      const recentMeetings = meetings
        .filter((m) => new Date(m.recordedAt) >= since)
        .slice(0, 10)
        .map((m) => ({
          id: m.id,
          title: m.title,
          source: m.source,
          recordedAt: m.recordedAt,
          summaryPreview: m.summaryMd?.slice(0, 200) ?? null,
        }));

      const pendingSpends = spends.items
        .filter((s) => s.status === "DRAFT" || s.status === "OPEN")
        .map((s) => ({
          id: s.id,
          amountCents: s.amountCents,
          currency: s.currency,
          description: s.description,
          status: s.status,
        }));

      return jsonResult({
        windowHours: windowHours ?? 24,
        since: since.toISOString(),
        webUrl: webUrl(workspaceId, ""),
        openActions: recentActions,
        inFlightProposals,
        freshTensions,
        recentMeetings,
        pendingSpends,
        counts: {
          openActions: recentActions.length,
          inFlightProposals: inFlightProposals.length,
          freshTensions: freshTensions.length,
          recentMeetings: recentMeetings.length,
          pendingSpends: pendingSpends.length,
        },
      });
    },
  );

  // ===========================================================================
  // EXTERNAL EXECUTION PLUMBING
  // ===========================================================================

  tool(
    "create_execution_request",
    "Create a governed Corgtex execution request for an external AI workspace. Returns a durable request id and packet metadata; the external tool executes, Corgtex provides context, policy, scopes, and write-back rules.",
    {
      goal: z.string().describe("The work goal the external AI workspace should execute"),
      provider: z.string().optional().describe("Optional provider key, such as OPENWORK, CHATGPT, CLAUDE, GEMINI, CURSOR, CLAUDE_CODE, or GENERIC_MCP"),
      actor: z.record(z.string(), z.unknown()).optional().describe("Optional actor summary to include in the packet"),
      context: z.unknown().optional().describe("Relevant context selected by the user or Corgtex"),
      allowedScopes: z.array(z.string()).optional().describe("Scope set the execution client may rely on"),
      policyConstraints: z.unknown().optional().describe("Company policy, security, approval, or governance constraints"),
      expectedOutput: z.unknown().optional().describe("Expected output shape"),
      approvalRule: z.string().optional().describe("Human approval or review rule"),
      writebackTargetType: z.string().optional().describe("ACTION, TENSION, PROPOSAL, MEETING, BRAIN_ARTICLE, BUILD_ARTIFACT, or COMMENT"),
      writebackTargetId: z.string().optional().describe("Optional existing target id for comment-style write-back"),
      writebackTargetLabel: z.string().optional(),
      idempotencyKey: z.string().optional().describe("Optional idempotency key supplied by the caller"),
    },
    async (params: {
      goal: string;
      provider?: string;
      actor?: Record<string, unknown>;
      context?: unknown;
      allowedScopes?: string[];
      policyConstraints?: unknown;
      expectedOutput?: unknown;
      approvalRule?: string;
      writebackTargetType?: string;
      writebackTargetId?: string;
      writebackTargetLabel?: string;
      idempotencyKey?: string;
    }) => {
      requireToolCapability("create_execution_request");
      const request = await createExecutionRequest(actor, {
        workspaceId,
        ...params,
      });
      return jsonResult({ ...request, webUrl: webUrl(workspaceId, `/settings?tab=ai-workspaces&executionRequest=${request.id}`) });
    },
  );

  tool(
    "get_execution_packet",
    "Retrieve the governed execution packet for an existing request. This returns goal, actor, context, allowed scopes, policy constraints, expected output, approval rule, and write-back target.",
    {
      requestId: z.string().describe("ExecutionRequest id"),
    },
    async ({ requestId }: { requestId: string }) => {
      requireToolCapability("get_execution_packet");
      const packet = await getExecutionPacket(actor, { workspaceId, requestId });
      return structuredJsonResult(packet as Record<string, unknown>);
    },
  );

  tool(
    "get_company_context",
    "Get scoped Corgtex company context for external execution: workspace metadata, recent public actions, tensions, proposals, meetings, Brain articles, and execution policy.",
    {},
    async () => {
      requireToolCapability("get_company_context");
      const context = await getCompanyContext(actor, workspaceId);
      return structuredJsonResult(context as Record<string, unknown>);
    },
  );

  tool(
    "list_writeback_targets",
    "List valid Corgtex write-back targets for an execution result. Use this before submitting output to avoid cross-workspace or invalid target ids.",
    {
      query: z.string().optional(),
      targetTypes: z.array(z.string()).optional().describe("Optional target type filter"),
      take: z.number().optional(),
    },
    async ({ query, targetTypes, take }: { query?: string; targetTypes?: string[]; take?: number }) => {
      requireToolCapability("list_writeback_targets");
      const targets = await listWritebackTargets(actor, { workspaceId, query, targetTypes, take });
      return structuredJsonResult(targets);
    },
  );

  tool(
    "submit_execution_result",
    "Submit an idempotent external AI workspace result back to Corgtex. Corgtex validates the target, creates draft/reviewable native records when appropriate, stores the result, and audits the write-back.",
    {
      requestId: z.string().describe("ExecutionRequest id"),
      idempotencyKey: z.string().describe("Stable result idempotency key"),
      targetType: z.string().optional().describe("Optional target override matching the request"),
      targetId: z.string().optional().describe("Optional existing target id matching the request"),
      output: z.record(z.string(), z.unknown()).optional().describe("Structured output; for new native records include title/bodyMd as needed"),
      artifacts: z.unknown().optional(),
      errorMessage: z.string().optional().describe("Set when execution failed; no native write-back will be created"),
    },
    async (params: {
      requestId: string;
      idempotencyKey: string;
      targetType?: string;
      targetId?: string;
      output?: Record<string, unknown>;
      artifacts?: unknown;
      errorMessage?: string;
    }) => {
      requireToolCapability("submit_execution_result");
      const result = await submitExecutionResult(actor, {
        workspaceId,
        ...params,
      });
      return jsonResult({ ...result, webUrl: webUrl(workspaceId, `/settings?tab=ai-workspaces&executionRequest=${params.requestId}`) });
    },
  );

  // ===========================================================================
  // SUPPORT / CONTROL PLANE
  // ===========================================================================

  tool(
    "record_support_audit",
    "Record a Corgtex Support audit event in this customer workspace. Support connector credentials only.",
    {
      action: z.string(),
      reason: z.string(),
      operationId: z.string(),
      phase: z.enum(["started", "completed", "failed"]).optional(),
      result: z.unknown().optional(),
      error: z.string().nullable().optional(),
    },
    async (params: {
      action: string;
      reason: string;
      operationId: string;
      phase?: "started" | "completed" | "failed";
      result?: unknown;
      error?: string | null;
    }) => {
      requireScope(sessionCtx, "support:write");
      const audit = await prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: params.action,
          entityType: "SupportOperation",
          entityId: params.operationId,
          meta: {
            reason: params.reason,
            phase: params.phase ?? "completed",
            result: params.result ?? null,
            error: params.error ?? null,
          },
        },
      });
      return jsonResult({ id: audit.id, operationId: params.operationId });
    },
  );

  tool(
    "list_integrations",
    "List installed workspace integrations for support diagnostics.",
    {},
    async () => {
      requireScope(sessionCtx, "integrations:read");
      const [communicationInstallations, oauthConnections] = await Promise.all([
        listCommunicationInstallations(actor, workspaceId),
        prisma.oAuthConnection.findMany({
          where: {
            user: {
              memberships: {
                some: { workspaceId, isActive: true },
              },
            },
          },
          select: {
            id: true,
            provider: true,
            providerAccountId: true,
            scopes: true,
            expiresAt: true,
            createdAt: true,
            updatedAt: true,
            user: { select: { email: true, displayName: true } },
          },
          orderBy: { updatedAt: "desc" },
        }),
      ]);
      return jsonResult({ communicationInstallations, oauthConnections });
    },
  );

  tool(
    "list_data_sources",
    "List external data feeds and their last sync state.",
    {},
    async () => {
      requireScope(sessionCtx, "data-sources:read");
      const sources = await listExternalDataSources(actor, workspaceId, { archiveFilter: "active" });
      return jsonResult({ items: sources });
    },
  );

  tool(
    "sync_data_source",
    "Queue a manual sync for an external data feed.",
    {
      sourceId: z.string(),
    },
    async ({ sourceId }: { sourceId: string }) => {
      requireScope(sessionCtx, "data-sources:write");
      const job = await enqueueExternalDataSourceSync(actor, { workspaceId, sourceId });
      return jsonResult({ id: job.id, status: job.status, webUrl: webUrl(workspaceId, `/settings?tab=data-sources`) });
    },
  );

  tool(
    "list_tool_links",
    "List protected or launchable workspace tool links and access notes. Plain reference links and vendor notes belong in Brain. Does not return decrypted credentials.",
    {},
    async () => {
      requireToolCapability("list_tool_links");
      const links = await listWorkspaceToolLinks(actor, { workspaceId });
      return jsonResult({ items: links, webUrl: webUrl(workspaceId, `/tools`) });
    },
  );

  tool(
    "upsert_tool_link",
    "Create or update a protected or launchable workspace tool link. Pass toolLinkId to update an existing link. Use Brain for plain reference links or vendor notes. Credential values are encrypted and never returned.",
    {
      toolLinkId: z.string().optional(),
      title: z.string(),
      url: z.string(),
      category: z.string().optional(),
      descriptionMd: z.string().nullable().optional(),
      accessNotesMd: z.string().nullable().optional(),
      previewTitle: z.string().nullable().optional(),
      previewDescription: z.string().nullable().optional(),
      previewImageUrl: z.string().nullable().optional(),
      previewFaviconUrl: z.string().nullable().optional(),
      credentialLabel: z.string().nullable().optional(),
      credentialSecret: z.string().nullable().optional(),
      circleIds: z.array(z.string()).optional(),
    },
    async (params: {
      toolLinkId?: string;
      title: string;
      url: string;
      category?: string;
      descriptionMd?: string | null;
      accessNotesMd?: string | null;
      previewTitle?: string | null;
      previewDescription?: string | null;
      previewImageUrl?: string | null;
      previewFaviconUrl?: string | null;
      credentialLabel?: string | null;
      credentialSecret?: string | null;
      circleIds?: string[];
    }) => {
      requireToolCapability("upsert_tool_link");
      const link = await upsertWorkspaceToolLink(actor, {
        workspaceId,
        toolLinkId: params.toolLinkId,
        title: params.title,
        url: params.url,
        category: params.category,
        descriptionMd: params.descriptionMd,
        accessNotesMd: params.accessNotesMd,
        previewTitle: params.previewTitle,
        previewDescription: params.previewDescription,
        previewImageUrl: params.previewImageUrl,
        previewFaviconUrl: params.previewFaviconUrl,
        credentialLabel: params.credentialLabel,
        credentialSecret: params.credentialSecret,
        circleIds: params.circleIds,
      });
      return jsonResult({
        id: link.id,
        title: link.title,
        hasCredential: link.hasCredential,
        webUrl: webUrl(workspaceId, `/tools`),
      });
    },
  );

  tool(
    "reveal_tool_link_credential",
    "Reveal the saved credential for a shared workspace tool link. This is sensitive, audited, and follows the same workspace role rules as the Tools tab.",
    {
      toolLinkId: z.string(),
    },
    async ({ toolLinkId }: { toolLinkId: string }) => {
      requireToolCapability("reveal_tool_link_credential");
      const credential = await revealWorkspaceToolLinkCredential(actor, { workspaceId, toolLinkId });
      return jsonResult({
        toolLinkId,
        credentialLabel: credential.credentialLabel,
        credentialSecret: credential.credentialSecret,
      });
    },
  );

  tool(
    "archive_tool_link",
    "Archive a shared workspace tool link so it stops appearing in active tools.",
    {
      toolLinkId: z.string(),
      reason: z.string().nullable().optional(),
    },
    async ({ toolLinkId, reason }: { toolLinkId: string; reason?: string | null }) => {
      requireToolCapability("archive_tool_link");
      await archiveWorkspaceToolLink(actor, { workspaceId, toolLinkId, reason });
      return jsonResult({ id: toolLinkId, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "list_agent_runs",
    "List recent agent runs, steps, tool calls, and model usage for support diagnostics.",
    {
      take: z.number().optional(),
    },
    async ({ take }: { take?: number }) => {
      requireScope(sessionCtx, "agents:read");
      const runs = await listAgentRuns(actor, workspaceId, { take: take ?? 20 });
      return jsonResult({ items: runs });
    },
  );

  tool(
    "list_agent_credentials",
    "List agent credentials for support diagnostics. Does not return bearer tokens or token hashes.",
    {},
    async () => {
      requireScope(sessionCtx, "agents:read");
      const credentials = await listAgentCredentials(actor, workspaceId);
      return jsonResult({
        items: credentials.map(agentCredentialSummary),
      });
    },
  );

  tool(
    "update_agent_credential_scopes",
    "Update scopes on an existing agent credential. Does not rotate or reveal the bearer token.",
    {
      credentialId: z.string(),
      scopes: z.array(z.string()),
    },
    async ({ credentialId, scopes }: { credentialId: string; scopes: string[] }) => {
      requireScope(sessionCtx, "support:write");
      const credential = await updateAgentCredentialScopes(actor, { workspaceId, credentialId, scopes });
      return jsonResult({ credential: agentCredentialSummary(credential) });
    },
  );

  tool(
    "revoke_agent_credential",
    "Revoke an active agent credential. Does not reveal token material.",
    {
      credentialId: z.string(),
    },
    async ({ credentialId }: { credentialId: string }) => {
      requireScope(sessionCtx, "support:write");
      const credential = await revokeAgentCredential(actor, { workspaceId, credentialId });
      return jsonResult({ credential: agentCredentialSummary(credential) });
    },
  );

  tool(
    "list_agent_configs",
    "List agent configuration states for support diagnostics. Governance policy bodies are redacted.",
    {},
    async () => {
      requireScope(sessionCtx, "agents:read");
      const configs = await listAgentConfigs(actor, workspaceId);
      return jsonResult({
        items: configs.map((config) => ({
          agentKey: config.agentKey,
          label: config.label,
          category: config.category,
          enabled: config.enabled,
          modelOverride: config.modelOverride,
          hasGovernancePolicy: Boolean(config.governancePolicy?.trim()),
          costTier: config.costTier,
        })),
      });
    },
  );

  tool(
    "update_agent_policy",
    "Update an agent governance policy or model override for support repair. Returns only redacted policy state.",
    {
      agentKey: z.string(),
      governancePolicy: z.string().nullable().optional(),
      modelOverride: z.string().nullable().optional(),
    },
    async (params: { agentKey: string; governancePolicy?: string | null; modelOverride?: string | null }) => {
      requireScope(sessionCtx, "support:write");
      const config = await updateAgentConfig(actor, {
        workspaceId,
        agentKey: params.agentKey,
        governancePolicy: params.governancePolicy,
        modelOverride: params.modelOverride,
      });
      return jsonResult({
        config: {
          id: config.id,
          agentKey: config.agentKey,
          enabled: config.enabled,
          modelOverride: config.modelOverride,
          hasGovernancePolicy: Boolean(config.governancePolicy?.trim()),
          updatedAt: config.updatedAt,
        },
      });
    },
  );

  tool(
    "get_model_budget",
    "Get the workspace model budget for support diagnostics.",
    {},
    async () => {
      requireScope(sessionCtx, "agents:read");
      const budget = await getModelUsageBudget(actor, workspaceId);
      return jsonResult({ budget });
    },
  );

  tool(
    "update_model_budget",
    "Update the workspace model budget for support repair.",
    {
      monthlyCostCapUsd: z.number(),
      alertThresholdPct: z.number().optional(),
      periodStartDay: z.number().optional(),
    },
    async (params: { monthlyCostCapUsd: number; alertThresholdPct?: number; periodStartDay?: number }) => {
      requireScope(sessionCtx, "support:write");
      const budget = await updateModelUsageBudget(actor, { workspaceId, ...params });
      return jsonResult({ budget });
    },
  );

  tool(
    "list_runtime_jobs",
    "List recent workflow jobs for support diagnostics.",
    {
      take: z.number().optional(),
    },
    async ({ take }: { take?: number }) => {
      requireScope(sessionCtx, "runtime:read");
      const jobs = await listRuntimeJobs(actor, workspaceId, { take: take ?? 50 });
      return jsonResult({ items: jobs });
    },
  );

  tool(
    "list_failed_jobs",
    "List failed workflow jobs for support diagnostics.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "runtime:read");
      const jobs = await listFailedJobs(actor, workspaceId, { take: take ?? 50, skip: skip ?? 0 });
      return jsonResult({ items: jobs });
    },
  );

  tool(
    "retry_failed_job",
    "Replay a failed workflow job for support repair.",
    {
      workflowJobId: z.string(),
    },
    async ({ workflowJobId }: { workflowJobId: string }) => {
      requireScope(sessionCtx, "runtime:write");
      const job = await replayWorkflowJob(actor, { workspaceId, workflowJobId });
      return jsonResult({ id: job.id, status: job.status, webUrl: webUrl(workspaceId, `/operator`) });
    },
  );

  tool(
    "discard_failed_job",
    "Mark a failed workflow job as cancelled for support repair.",
    {
      workflowJobId: z.string(),
    },
    async ({ workflowJobId }: { workflowJobId: string }) => {
      requireScope(sessionCtx, "runtime:write");
      const result = await discardFailedJob(actor, { workspaceId, workflowJobId });
      return jsonResult({ count: result.count, webUrl: webUrl(workspaceId, `/operator`) });
    },
  );

  tool(
    "upload_document_text",
    "Upload support-provided text data into workspace documents. Use this for batch customer data drops that do not need binary storage.",
    {
      title: z.string(),
      source: z.string().optional(),
      textContent: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    async (params: { title: string; source?: string; textContent: string; metadata?: Record<string, unknown> }) => {
      requireScope(sessionCtx, "documents:write");
      const document = await createDocument(actor, {
        workspaceId,
        title: params.title,
        source: params.source ?? "corgtex-support",
        storageKey: `support-upload/${Date.now()}-${params.title.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
        mimeType: "text/plain",
        textContent: params.textContent,
        metadata: params.metadata ?? { uploadedBy: "corgtex-support" },
      });
      return jsonResult({ id: document.id, title: document.title, webUrl: webUrl(workspaceId, `/settings?tab=data-sources`) });
    },
  );

  // ===========================================================================
  // PROPOSALS
  // ===========================================================================

  tool(
    "list_proposals",
    "List governance proposals in the workspace.",
    {
      take: z.number().optional().describe("Number of proposals to return (default 20)"),
      skip: z.number().optional().describe("Number of proposals to skip for pagination"),
      archiveFilter: z.enum(ARCHIVE_FILTER).optional().describe("active, archived, or all"),
    },
    async ({ take, skip, archiveFilter }: { take?: number; skip?: number; archiveFilter?: typeof ARCHIVE_FILTER[number] }) => {
      requireScope(sessionCtx, "proposals:read");
      const result = await listProposals(actor, workspaceId, { take, skip, archiveFilter });
      const simplified = result.items.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        version: p.version,
        resolutionOutcome: p.resolutionOutcome,
        decidedAt: p.decidedAt,
        archivedAt: p.archivedAt,
        summary: p.summary,
        author: p.author?.displayName ?? p.author?.email ?? "Unknown",
        createdAt: p.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  tool(
    "get_proposal",
    "Get the full record for a single proposal, including author and current status.",
    {
      proposalId: z.string().describe("Proposal ID"),
    },
    async ({ proposalId }: { proposalId: string }) => {
      requireScope(sessionCtx, "proposals:read");
      const proposal = await prisma.proposal.findFirst({
        where: { id: proposalId, workspaceId },
        include: {
          author: { select: { displayName: true, email: true } },
          circle: { select: { id: true, name: true } },
        },
      });
      if (!proposal) return jsonResult({ error: "Not found" });
      return jsonResult({
        ...proposal,
        webUrl: webUrl(workspaceId, `/proposals/${proposal.id}`),
      });
    },
  );

  // @ts-expect-error — MCP SDK overload triggers TS2589 with zod schemas
  tool(
    "create_proposal",
    "Create a new governance proposal draft. Starts in DRAFT and must be opened separately with the circle.",
    {
      title: z.string().describe("Proposal title"),
      bodyMd: z.string().describe("Proposal body in Markdown"),
      summary: z.string().optional().describe("Optional short summary"),
      authorMemberId: z.string().optional().describe("Optional active member ID to attribute as author when an internal/credential agent creates the proposal"),
    },
    async ({ title, bodyMd, summary, authorMemberId }: { title: string; bodyMd: string; summary?: string; authorMemberId?: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const proposal = await createProposal(actor, { workspaceId, title, bodyMd, summary, authorMemberId });
      return jsonResult({
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        version: proposal.version,
        webUrl: webUrl(workspaceId, `/proposals/${proposal.id}`),
      });
    },
  );

  tool(
    "update_proposal",
    "Update a proposal's title, body, summary, or owning circle. Draft edits keep draft-manager permissions; OPEN proposal content edits require the connected author and create a saved previous version.",
    {
      proposalId: z.string(),
      title: z.string().optional(),
      bodyMd: z.string().optional(),
      summary: z.string().optional(),
      circleId: z.string().optional(),
    },
    async (params: { proposalId: string; title?: string; bodyMd?: string; summary?: string; circleId?: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const updated = await updateProposal(actor, {
        workspaceId,
        proposalId: params.proposalId,
        title: params.title,
        bodyMd: params.bodyMd,
        summary: params.summary,
        circleId: params.circleId ?? undefined,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  tool(
    "submit_proposal",
    "Open a DRAFT proposal to the workspace. Starts an approval flow per the workspace's approval policy.",
    {
      proposalId: z.string(),
    },
    async ({ proposalId }: { proposalId: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const result = await submitProposal(actor, { workspaceId, proposalId });
      return jsonResult({
        id: result.proposalId,
        flowId: result.flowId,
        status: "OPEN",
        webUrl: webUrl(workspaceId, `/proposals/${result.proposalId}`),
      });
    },
  );

  tool(
    "resolve_proposal",
    "Manually resolve an OPEN proposal with an explicit outcome and required resolution note.",
    {
      proposalId: z.string(),
      outcome: z.enum(["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"]),
      decisionMd: z.string().min(1).describe("Required note describing how or why the proposal was resolved."),
    },
    async ({ proposalId, outcome, decisionMd }: { proposalId: string; outcome: "ADOPTED" | "NOT_ADOPTED" | "WITHDRAWN"; decisionMd: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const updated = await resolveProposal(actor, { workspaceId, proposalId, outcome, decisionMd });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        resolutionOutcome: updated.resolutionOutcome,
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  tool(
    "archive_proposal",
    "Archive a draft or resolved proposal so it stops appearing in active lists.",
    {
      proposalId: z.string(),
    },
    async ({ proposalId }: { proposalId: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const updated = await archiveProposal(actor, { workspaceId, proposalId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  tool(
    "publish_proposal",
    "Legacy visibility-only helper for private draft proposals. Prefer submit_proposal when the user asks to Open a proposal.",
    {
      proposalId: z.string(),
    },
    async ({ proposalId }: { proposalId: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const updated = await publishProposal(actor, { workspaceId, proposalId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  tool(
    "return_proposal_to_draft",
    "Return an OPEN proposal to DRAFT so authorized draft managers can edit it. Clears active approval decisions, objections, and stale flow state so reopening starts fresh.",
    {
      proposalId: z.string(),
    },
    async ({ proposalId }: { proposalId: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const updated = await returnProposalToDraft(actor, { workspaceId, proposalId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  tool(
    "support_reopen_resolved_proposals",
    "Support-only repair: reopen RESOLVED proposals, clear resolution fields, reactivate approval flows, remove adopted policy corpus rows, and record an audit note.",
    {
      proposalIds: z.array(z.string()).min(1).max(25),
      reason: z.string(),
    },
    async ({ proposalIds, reason }: { proposalIds: string[]; reason: string }) => {
      requireScope(sessionCtx, "support:write");
      requireScope(sessionCtx, "proposals:write");
      const result = await supportReopenResolvedProposals(actor, {
        workspaceId,
        proposalIds,
        reason,
      });
      return jsonResult({
        ...result,
        webUrls: result.reopened.map((proposal) => webUrl(workspaceId, `/proposals/${proposal.id}`)),
      });
    },
  );

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  tool(
    "list_actions",
    "List action items (todos / commitments) in the workspace.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
      archiveFilter: z.enum(ARCHIVE_FILTER).optional(),
    },
    async ({ take, skip, archiveFilter }: { take?: number; skip?: number; archiveFilter?: typeof ARCHIVE_FILTER[number] }) => {
      requireScope(sessionCtx, "actions:read");
      const result = await listActions(actor, workspaceId, { take, skip, archiveFilter });
      const simplified = result.items.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        version: a.version,
        author: a.author?.displayName ?? a.author?.email ?? "Unknown",
        assignee: a.assigneeMember?.user?.displayName ?? a.assigneeMember?.user?.email ?? null,
        dueAt: (a as Record<string, unknown>).dueAt ?? null,
        archivedAt: a.archivedAt,
        createdAt: a.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  tool(
    "create_action",
    "Create a new private DRAFT action item.",
    {
      title: z.string(),
      bodyMd: z.string().optional(),
      assigneeMemberId: z.string().optional(),
      authorMemberId: z.string().optional().describe("Optional active member ID to attribute as author when an internal/credential agent creates the action"),
    },
    async ({ title, bodyMd, assigneeMemberId, authorMemberId }: { title: string; bodyMd?: string; assigneeMemberId?: string; authorMemberId?: string }) => {
      requireScope(sessionCtx, "actions:write");
      const action = await createAction(actor, { workspaceId, title, bodyMd, assigneeMemberId, authorMemberId });
      return jsonResult({
        id: action.id,
        status: action.status,
        version: action.version,
        webUrl: webUrl(workspaceId, `/actions/${action.id}`),
      });
    },
  );

  tool(
    "update_action",
    "Update an action. Draft content edits keep draft-manager permissions; OPEN/IN_PROGRESS content edits require the connected author and create a saved previous version.",
    {
      actionId: z.string(),
      title: z.string().optional(),
      bodyMd: z.string().optional(),
      status: z.enum(ACTION_STATUS).optional(),
      circleId: z.string().optional(),
      assigneeMemberId: z.string().optional(),
      dueAt: z.string().optional().describe("ISO 8601 date string"),
    },
    async (params: {
      actionId: string;
      title?: string;
      bodyMd?: string;
      status?: typeof ACTION_STATUS[number];
      circleId?: string;
      assigneeMemberId?: string;
      dueAt?: string;
    }) => {
      requireScope(sessionCtx, "actions:write");
      const updated = await updateAction(actor, {
        workspaceId,
        actionId: params.actionId,
        title: params.title,
        bodyMd: params.bodyMd,
        status: params.status,
        circleId: params.circleId,
        assigneeMemberId: params.assigneeMemberId,
        dueAt: params.dueAt ? new Date(params.dueAt) : undefined,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/actions/${updated.id}`),
      });
    },
  );

  tool(
    "complete_action",
    "Mark an action as COMPLETED. Convenience wrapper around update_action.",
    {
      actionId: z.string(),
    },
    async ({ actionId }: { actionId: string }) => {
      requireScope(sessionCtx, "actions:write");
      const updated = await updateAction(actor, { workspaceId, actionId, status: "COMPLETED" });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/actions/${updated.id}`),
      });
    },
  );

  tool(
    "return_action_to_draft",
    "Return an OPEN or IN_PROGRESS action to DRAFT so authorized draft managers can edit it. Completed or archived actions cannot be returned.",
    {
      actionId: z.string(),
    },
    async ({ actionId }: { actionId: string }) => {
      requireScope(sessionCtx, "actions:write");
      const updated = await returnActionToDraft(actor, { workspaceId, actionId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/actions/${updated.id}`),
      });
    },
  );

  tool(
    "delete_action",
    "Archive an action so it stops appearing in active views. The record remains recoverable from the archive.",
    {
      actionId: z.string(),
    },
    async ({ actionId }: { actionId: string }) => {
      requireScope(sessionCtx, "actions:write");
      const result = await deleteAction(actor, { workspaceId, actionId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  // ===========================================================================
  // TENSIONS
  // ===========================================================================

  tool(
    "list_tensions",
    "List tensions (issues/concerns raised by members).",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
      archiveFilter: z.enum(ARCHIVE_FILTER).optional(),
    },
    async ({ take, skip, archiveFilter }: { take?: number; skip?: number; archiveFilter?: typeof ARCHIVE_FILTER[number] }) => {
      requireScope(sessionCtx, "tensions:read");
      const result = await listTensions(actor, workspaceId, { take, skip, archiveFilter });
      const simplified = result.items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        version: t.version,
        author: t.author?.displayName ?? t.author?.email ?? "Unknown",
        assignee: t.assigneeMember?.user?.displayName ?? t.assigneeMember?.user?.email ?? null,
        raisedBy: t.raisedByMember?.user?.displayName ?? t.raisedByMember?.user?.email ?? null,
        resolvedVia: t.resolvedVia,
        archivedAt: t.archivedAt,
        createdAt: t.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  tool(
    "create_tension",
    "Create a new private DRAFT tension (issue/concern).",
    {
      title: z.string(),
      bodyMd: z.string().optional(),
      raisedByMemberId: z.string().optional(),
      authorMemberId: z.string().optional().describe("Optional active member ID to attribute as author when an internal/credential agent creates the tension"),
    },
    async ({ title, bodyMd, raisedByMemberId, authorMemberId }: { title: string; bodyMd?: string; raisedByMemberId?: string; authorMemberId?: string }) => {
      requireScope(sessionCtx, "tensions:write");
      const tension = await createTension(actor, { workspaceId, title, bodyMd, raisedByMemberId, authorMemberId });
      return jsonResult({
        id: tension.id,
        status: tension.status,
        version: tension.version,
        webUrl: webUrl(workspaceId, `/tensions/${tension.id}`),
      });
    },
  );

  tool(
    "update_tension",
    "Update a tension. Draft content edits keep draft-manager permissions; OPEN tension content edits require the connected author and create a saved previous version.",
    {
      tensionId: z.string(),
      title: z.string().optional(),
      bodyMd: z.string().optional(),
      status: z.enum(TENSION_STATUS).optional(),
      circleId: z.string().optional(),
      assigneeMemberId: z.string().optional(),
      raisedByMemberId: z.string().optional(),
      priority: z.number().optional(),
      resolvedVia: z.string().optional().describe("Required when setting status to RESOLVED"),
    },
    async (params: {
      tensionId: string;
      title?: string;
      bodyMd?: string;
      status?: typeof TENSION_STATUS[number];
      circleId?: string;
      assigneeMemberId?: string;
      raisedByMemberId?: string;
      priority?: number;
      resolvedVia?: string;
    }) => {
      requireScope(sessionCtx, "tensions:write");
      const updated = await updateTension(actor, {
        workspaceId,
        tensionId: params.tensionId,
        title: params.title,
        bodyMd: params.bodyMd,
        status: params.status,
        circleId: params.circleId,
        assigneeMemberId: params.assigneeMemberId,
        raisedByMemberId: params.raisedByMemberId,
        priority: params.priority,
        resolvedVia: params.resolvedVia,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/tensions/${updated.id}`),
      });
    },
  );

  tool(
    "return_tension_to_draft",
    "Return an OPEN tension to DRAFT so authorized draft managers can edit it. Resolved or archived tensions cannot be returned.",
    {
      tensionId: z.string(),
    },
    async ({ tensionId }: { tensionId: string }) => {
      requireScope(sessionCtx, "tensions:write");
      const updated = await returnTensionToDraft(actor, { workspaceId, tensionId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/tensions/${updated.id}`),
      });
    },
  );

  tool(
    "upvote_tension",
    "Upvote a tension to signal support. User-only — agents cannot upvote on a user's behalf.",
    {
      tensionId: z.string(),
    },
    async ({ tensionId }: { tensionId: string }) => {
      requireScope(sessionCtx, "tensions:write");
      const upvote = await upvoteTension(actor, { workspaceId, tensionId });
      return jsonResult({
        id: tensionId,
        upvoteId: upvote.tensionId,
        webUrl: webUrl(workspaceId, `/tensions/${tensionId}`),
      });
    },
  );

  tool(
    "delete_tension",
    "Archive a tension so it stops appearing in active views. The record remains recoverable from the archive.",
    {
      tensionId: z.string(),
    },
    async ({ tensionId }: { tensionId: string }) => {
      requireScope(sessionCtx, "tensions:write");
      const result = await deleteTension(actor, { workspaceId, tensionId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  // ===========================================================================
  // GOALS
  // ===========================================================================

  tool(
    "list_goals",
    "List goals in the workspace, optionally filtered by cadence, level, or status.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
      cadence: z.enum(GOAL_CADENCE).optional(),
      level: z.enum(GOAL_LEVEL).optional(),
      status: z.enum(GOAL_STATUS).optional(),
    },
    async (params: {
      take?: number;
      skip?: number;
      cadence?: typeof GOAL_CADENCE[number];
      level?: typeof GOAL_LEVEL[number];
      status?: typeof GOAL_STATUS[number];
    }) => {
      requireScope(sessionCtx, "goals:read");
      const goals = await listGoals(actor, {
        workspaceId,
        take: params.take,
        skip: params.skip,
        cadence: params.cadence,
        level: params.level,
        status: params.status,
      });
      const simplified = goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        cadence: goal.cadence,
        level: goal.level,
        status: goal.status,
        version: goal.version,
        progressPercent: goal.progressPercent,
        circle: goal.circle?.name ?? null,
        owner: goal.ownerMember?.user?.displayName ?? goal.ownerMember?.user?.email ?? null,
        keyResults: goal.keyResults.map((keyResult) => ({
          id: keyResult.id,
          title: keyResult.title,
          targetValue: keyResult.targetValue,
          currentValue: keyResult.currentValue,
          unit: keyResult.unit,
          progressPercent: keyResult.progressPercent,
        })),
        webUrl: webUrl(workspaceId, `/goals?view=tree&cadence=${goal.cadence}`),
      }));
      return jsonResult({ items: simplified, total: simplified.length });
    },
  );

  tool(
    "get_goal",
    "Get the full record for a single goal, including key results and updates.",
    {
      goalId: z.string(),
    },
    async ({ goalId }: { goalId: string }) => {
      requireScope(sessionCtx, "goals:read");
      const goal = await getGoal(actor, { workspaceId, goalId });
      return jsonResult({
        ...goal,
        webUrl: webUrl(workspaceId, `/goals?view=tree&cadence=${goal.cadence}`),
      });
    },
  );

  tool(
    "create_goal",
    "Create a new workspace goal in the Goals tab with optional key results. Goals default to DRAFT unless a status is provided.",
    {
      title: z.string(),
      descriptionMd: z.string().optional(),
      cadence: z.enum(GOAL_CADENCE).optional(),
      level: z.enum(GOAL_LEVEL).optional(),
      status: z.enum(GOAL_STATUS).optional(),
      targetDate: z.string().optional().describe("ISO 8601 date string"),
      startDate: z.string().optional().describe("ISO 8601 date string"),
      parentGoalId: z.string().optional(),
      circleId: z.string().optional(),
      ownerMemberId: z.string().optional(),
      keyResults: z.array(z.object({
        title: z.string(),
        targetValue: z.number().nullable().optional(),
        currentValue: z.number().nullable().optional(),
        unit: z.string().nullable().optional(),
      })).optional(),
    },
    async (params: {
      title: string;
      descriptionMd?: string;
      cadence?: typeof GOAL_CADENCE[number];
      level?: typeof GOAL_LEVEL[number];
      status?: typeof GOAL_STATUS[number];
      targetDate?: string;
      startDate?: string;
      parentGoalId?: string;
      circleId?: string;
      ownerMemberId?: string;
      keyResults?: Array<{ title: string; targetValue?: number | null; currentValue?: number | null; unit?: string | null }>;
    }) => {
      requireScope(sessionCtx, "goals:write");
      const goal = await createGoal(actor, {
        workspaceId,
        title: params.title,
        descriptionMd: params.descriptionMd,
        cadence: params.cadence,
        level: params.level,
        status: params.status,
        targetDate: params.targetDate ? new Date(params.targetDate) : undefined,
        startDate: params.startDate ? new Date(params.startDate) : undefined,
        parentGoalId: params.parentGoalId,
        circleId: params.circleId,
        ownerMemberId: params.ownerMemberId,
        keyResults: params.keyResults,
      });
      return jsonResult({
        id: goal.id,
        title: goal.title,
        status: goal.status,
        version: goal.version,
        webUrl: webUrl(workspaceId, `/goals?view=tree&cadence=${goal.cadence}`),
      });
    },
  );

  tool(
    "update_goal",
    "Update a workspace goal's status, progress, dates, ownership, or content fields. Pass only the fields you want to change.",
    {
      goalId: z.string(),
      title: z.string().optional(),
      descriptionMd: z.string().optional(),
      cadence: z.enum(GOAL_CADENCE).optional(),
      level: z.enum(GOAL_LEVEL).optional(),
      status: z.enum(GOAL_STATUS).optional(),
      progressPercent: z.number().optional(),
      targetDate: z.string().nullable().optional().describe("ISO 8601 date string or null"),
      startDate: z.string().nullable().optional().describe("ISO 8601 date string or null"),
      parentGoalId: z.string().nullable().optional(),
      circleId: z.string().nullable().optional(),
      ownerMemberId: z.string().nullable().optional(),
    },
    async (params: {
      goalId: string;
      title?: string;
      descriptionMd?: string;
      cadence?: typeof GOAL_CADENCE[number];
      level?: typeof GOAL_LEVEL[number];
      status?: typeof GOAL_STATUS[number];
      progressPercent?: number;
      targetDate?: string | null;
      startDate?: string | null;
      parentGoalId?: string | null;
      circleId?: string | null;
      ownerMemberId?: string | null;
    }) => {
      requireScope(sessionCtx, "goals:write");
      const updated = await updateGoal(actor, {
        workspaceId,
        goalId: params.goalId,
        title: params.title,
        descriptionMd: params.descriptionMd,
        cadence: params.cadence,
        level: params.level,
        status: params.status,
        progressPercent: params.progressPercent,
        targetDate: params.targetDate === undefined ? undefined : params.targetDate ? new Date(params.targetDate) : null,
        startDate: params.startDate === undefined ? undefined : params.startDate ? new Date(params.startDate) : null,
        parentGoalId: params.parentGoalId,
        circleId: params.circleId,
        ownerMemberId: params.ownerMemberId,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/goals?view=tree&cadence=${updated.cadence}`),
      });
    },
  );

  tool(
    "return_goal_to_draft",
    "Return an active goal to DRAFT so authorized draft managers can edit it. Completed, abandoned, or archived goals cannot be returned.",
    {
      goalId: z.string(),
    },
    async ({ goalId }: { goalId: string }) => {
      requireScope(sessionCtx, "goals:write");
      const updated = await returnGoalToDraft(actor, { workspaceId, goalId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/goals?view=tree&cadence=${updated.cadence}`),
      });
    },
  );

  tool(
    "archive_goal",
    "Archive a goal so it stops appearing in active views. The record remains recoverable from the archive.",
    {
      goalId: z.string(),
    },
    async ({ goalId }: { goalId: string }) => {
      requireScope(sessionCtx, "goals:write");
      await deleteGoal(actor, { workspaceId, goalId });
      return jsonResult({ id: goalId, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  // ===========================================================================
  // MEMBERS
  // ===========================================================================

  tool(
    "list_members",
    "List members of the workspace with their roles. Pass includeInactive to include deactivated members.",
    {
      includeInactive: z.boolean().optional(),
    },
    async ({ includeInactive }: { includeInactive?: boolean }) => {
      requireScope(sessionCtx, "members:read");
      const members = includeInactive
        ? await listMembersEnriched(workspaceId, { includeInactive: true })
        : await listMembers(workspaceId);
      const simplified = members.map((m) => ({
        id: m.id,
        displayName: m.user.displayName,
        email: m.user.email,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt,
      }));
      return jsonResult({ members: simplified });
    },
  );

  tool(
    "create_member",
    "Onboard a new member. Creates the user account if it doesn't exist, adds them to the workspace with the chosen role, and issues a setup link token. Admin-only.",
    {
      email: z.string(),
      role: z.enum(MEMBER_ROLE),
      displayName: z.string().optional(),
    },
    async (params: { email: string; role: typeof MEMBER_ROLE[number]; displayName?: string }) => {
      requireScope(sessionCtx, "members:write");
      const result = await createMember(actor, {
        workspaceId,
        email: params.email,
        role: params.role,
        displayName: params.displayName,
      });
      const emailStatus = await sendMemberSetupEmail({
        email: result.user.email,
        displayName: result.user.displayName,
        token: result.token,
      });
      return jsonResult({
        id: result.member.id,
        userId: result.user.id,
        email: result.user.email,
        role: result.member.role,
        emailStatus,
        webUrl: webUrl(workspaceId, `/settings?tab=members`),
      });
    },
  );

  tool(
    "update_member",
    "Update a member's email, role, display name, or active status. Admin-only.",
    {
      memberId: z.string(),
      role: z.enum(MEMBER_ROLE).optional(),
      displayName: z.string().optional(),
      email: z.string().optional(),
      isActive: z.boolean().optional(),
    },
    async (params: { memberId: string; role?: typeof MEMBER_ROLE[number]; displayName?: string; email?: string; isActive?: boolean }) => {
      requireScope(sessionCtx, "members:write");
      const updated = await updateMember(actor, {
        workspaceId,
        memberId: params.memberId,
        role: params.role,
        displayName: params.displayName,
        email: params.email,
        isActive: params.isActive,
      });
      return jsonResult({
        id: updated.id,
        role: updated.role,
        isActive: updated.isActive,
        email: updated.user.email,
        webUrl: webUrl(workspaceId, `/settings?tab=members`),
      });
    },
  );

  tool(
    "resend_member_access_link",
    "Issue and email a fresh setup/reset access link for a workspace member. Admin-only. Does not expose or set a raw password.",
    {
      memberId: z.string(),
    },
    async ({ memberId }: { memberId: string }) => {
      requireScope(sessionCtx, "members:write");
      const result = await resendMemberAccessLink(actor, { workspaceId, memberId });
      const emailStatus = await sendMemberSetupEmail({
        email: result.user.email,
        displayName: result.user.displayName,
        token: result.token,
      });
      return jsonResult({
        id: result.member.id,
        email: result.user.email,
        emailStatus,
        webUrl: webUrl(workspaceId, `/settings?tab=members`),
      });
    },
  );

  tool(
    "list_feature_flags",
    "List workspace feature flags with defaults and current values.",
    {},
    async () => {
      requireScope(sessionCtx, "workspace:read");
      const records = await prisma.workspaceFeatureFlag.findMany({
        where: {
          workspaceId,
          flag: { in: CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => definition.flag) },
        },
        select: { flag: true, enabled: true, config: true, updatedAt: true },
      });
      const recordMap = new Map(records.map((record) => [record.flag, record]));
      return jsonResult({
        flags: CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => {
          const record = recordMap.get(definition.flag);
          return {
            ...definition,
            enabled: record?.enabled ?? definition.defaultEnabled,
            config: record?.config ?? null,
            source: record ? "workspace_override" : "default",
            updatedAt: record?.updatedAt ?? null,
          };
        }),
      });
    },
  );

  tool(
    "set_feature_flag",
    "Enable or disable one known workspace feature flag. Admin-only. Optionally set public-safe JSON config for flags that require rollout settings.",
    {
      flag: z.enum(CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => definition.flag) as [string, ...string[]]),
      enabled: z.boolean(),
      config: z.unknown().optional(),
    },
    async (input: { flag: string; enabled: boolean; config?: unknown }) => {
      const { flag, enabled, config } = input;
      requireScope(sessionCtx, "workspace:write");
      const hasConfig = Object.prototype.hasOwnProperty.call(input, "config");
      const configData = hasConfig ? { config: config == null ? null : toInputJson(config) } : {};
      const record = await prisma.workspaceFeatureFlag.upsert({
        where: {
          workspaceId_flag: {
            workspaceId,
            flag,
          },
        },
        update: { enabled, ...configData },
        create: { workspaceId, flag, enabled, ...configData },
      });
      return jsonResult({
        flag: record.flag,
        enabled: record.enabled,
        config: record.config ?? null,
        webUrl: webUrl(workspaceId, `/settings`),
      });
    },
  );

  tool(
    "deactivate_member",
    "Deactivate a member (offboarding). They lose workspace access but their history is preserved. Admin-only.",
    {
      memberId: z.string(),
    },
    async ({ memberId }: { memberId: string }) => {
      requireScope(sessionCtx, "members:write");
      const updated = await deactivateMember(actor, { workspaceId, memberId });
      return jsonResult({
        id: updated.id,
        isActive: updated.isActive,
        webUrl: webUrl(workspaceId, `/settings?tab=members`),
      });
    },
  );

  // ===========================================================================
  // MEETINGS
  // ===========================================================================

  tool(
    "list_meetings",
    "List meetings in the workspace with their summaries.",
    {
      archiveFilter: z.enum(ARCHIVE_FILTER).optional(),
    },
    async ({ archiveFilter }: { archiveFilter?: typeof ARCHIVE_FILTER[number] }) => {
      requireScope(sessionCtx, "meetings:read");
      const meetings = await listMeetings(workspaceId, { archiveFilter });
      const simplified = meetings.map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
        recordedAt: m.recordedAt,
        hasSummary: Boolean(m.summaryMd),
        summaryPreview: m.summaryMd?.slice(0, 200) ?? null,
        archivedAt: m.archivedAt,
      }));
      return jsonResult(simplified);
    },
  );

  tool(
    "get_meeting",
    "Get the full record for a single meeting, including transcript, summary, linked proposals, and tensions raised.",
    {
      meetingId: z.string(),
    },
    async ({ meetingId }: { meetingId: string }) => {
      requireScope(sessionCtx, "meetings:read");
      const meeting = await getMeeting(workspaceId, meetingId);
      if (!meeting) return jsonResult({ error: "Not found" });
      return jsonResult({
        ...meeting,
        webUrl: webUrl(workspaceId, `/meetings/${meeting.id}`),
      });
    },
  );

  tool(
    "upload_meeting",
    "Upload meeting minutes / transcript / summary. The content is added to the workspace and indexed into the Brain so search_knowledge can find it within ~1 minute.",
    {
      title: z.string().optional().describe("Meeting title (defaults to source if omitted)"),
      source: z.string().describe("Where this came from — e.g. 'manual-upload', 'granola', 'fireflies'"),
      recordedAt: z.string().describe("ISO 8601 timestamp of when the meeting happened"),
      transcript: z.string().optional().describe("Full transcript Markdown / plain text"),
      summaryMd: z.string().optional().describe("Summary in Markdown — if omitted, the system may generate one"),
      participantIds: z.array(z.string()).optional().describe("Member IDs of attendees"),
    },
    async (params: {
      title?: string;
      source: string;
      recordedAt: string;
      transcript?: string;
      summaryMd?: string;
      participantIds?: string[];
    }) => {
      requireScope(sessionCtx, "meetings:write");
      if (!params.transcript?.trim()) {
        const meeting = await createMeeting(actor, {
          workspaceId,
          title: params.title ?? null,
          source: params.source,
          recordedAt: new Date(params.recordedAt),
          transcript: null,
          summaryMd: params.summaryMd ?? null,
          participantIds: params.participantIds ?? [],
        });
        return jsonResult({
          id: meeting.id,
          title: meeting.title,
          status: "meeting_created",
          recordedAt: meeting.recordedAt,
          webUrl: webUrl(workspaceId, `/meetings/${meeting.id}`),
        });
      }

      const result = await intakeMeetingTranscript(actor, {
        workspaceId,
        title: params.title ?? null,
        source: params.source,
        recordedAt: new Date(params.recordedAt),
        transcript: params.transcript,
        summaryMd: params.summaryMd ?? null,
        participantIds: params.participantIds ?? [],
      });
      if (result.status === "needs_clarification") {
        return jsonResult(result);
      }
      return jsonResult({
        id: result.meeting.id,
        title: result.meeting.title,
        status: result.status,
        recordedAt: result.meeting.recordedAt,
        webUrl: webUrl(workspaceId, `/meetings/${result.meeting.id}`),
      });
    },
  );

  tool(
    "delete_meeting",
    "Archive a meeting and its transcript so it stops appearing in active views. Admin-only.",
    {
      meetingId: z.string(),
    },
    async ({ meetingId }: { meetingId: string }) => {
      requireScope(sessionCtx, "meetings:write");
      const result = await deleteMeeting(actor, { workspaceId, meetingId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  // ===========================================================================
  // BRAIN — articles + discussions
  // ===========================================================================

  tool(
    "list_articles",
    "List Brain articles (policies, runbooks, decisions, glossaries, …). Filter by type, authority, or staleness.",
    {
      type: z.enum(BRAIN_ARTICLE_TYPE).optional(),
      authority: z.enum(BRAIN_ARTICLE_AUTHORITY).optional(),
      stale: z.boolean().optional().describe("If true, only return articles past their staleness window"),
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async (params: {
      type?: typeof BRAIN_ARTICLE_TYPE[number];
      authority?: typeof BRAIN_ARTICLE_AUTHORITY[number];
      stale?: boolean;
      take?: number;
      skip?: number;
    }) => {
      requireScope(sessionCtx, "brain:read");
      const result = await listArticles(actor, {
        workspaceId,
        type: params.type,
        authority: params.authority,
        stale: params.stale,
        take: params.take,
        skip: params.skip,
      });
      const simplified = result.items.map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.title,
        type: a.type,
        authority: a.authority,
        owner: a.ownerMember?.user?.displayName ?? a.ownerMember?.user?.email ?? null,
        updatedAt: a.updatedAt,
        webUrl: webUrl(workspaceId, `/brain/${a.slug}`),
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  tool(
    "get_article",
    "Get the full Markdown body and metadata for a Brain article by slug.",
    {
      slug: z.string(),
    },
    async ({ slug }: { slug: string }) => {
      requireScope(sessionCtx, "brain:read");
      const article = await getArticle(actor, { workspaceId, slug });
      return jsonResult({
        ...article,
        webUrl: webUrl(workspaceId, `/brain/${article.slug}`),
      });
    },
  );

  tool(
    "create_article",
    "Create a new Brain article (policy, runbook, decision, etc). The body is Markdown; wikilinks like [[slug]] are auto-linked.",
    {
      title: z.string(),
      type: z.enum(BRAIN_ARTICLE_TYPE),
      bodyMd: z.string(),
      slug: z.string().optional().describe("URL slug (auto-generated from title if omitted)"),
      authority: z.enum(BRAIN_ARTICLE_AUTHORITY).optional().describe("Defaults to DRAFT"),
      staleAfterDays: z.number().optional().describe("Days until this article is flagged stale (default 90)"),
    },
    async (params: {
      title: string;
      type: typeof BRAIN_ARTICLE_TYPE[number];
      bodyMd: string;
      slug?: string;
      authority?: typeof BRAIN_ARTICLE_AUTHORITY[number];
      staleAfterDays?: number;
    }) => {
      requireScope(sessionCtx, "brain:write");
      const article = await createArticle(actor, {
        workspaceId,
        title: params.title,
        type: params.type,
        bodyMd: params.bodyMd,
        slug: params.slug,
        authority: params.authority,
        staleAfterDays: params.staleAfterDays,
      });
      return jsonResult({
        id: article.id,
        slug: article.slug,
        type: article.type,
        webUrl: webUrl(workspaceId, `/brain/${article.slug}`),
      });
    },
  );

  tool(
    "update_article",
    "Update a DRAFT Brain article. Pass `changeSummary` to label the version snapshot. The previous body is preserved as a version row.",
    {
      slug: z.string(),
      title: z.string().optional(),
      type: z.enum(BRAIN_ARTICLE_TYPE).optional(),
      authority: z.enum(BRAIN_ARTICLE_AUTHORITY).optional(),
      bodyMd: z.string().optional(),
      changeSummary: z.string().optional(),
    },
    async (params: {
      slug: string;
      title?: string;
      type?: typeof BRAIN_ARTICLE_TYPE[number];
      authority?: typeof BRAIN_ARTICLE_AUTHORITY[number];
      bodyMd?: string;
      changeSummary?: string;
    }) => {
      requireScope(sessionCtx, "brain:write");
      const updated = await updateArticle(actor, {
        workspaceId,
        slug: params.slug,
        title: params.title,
        type: params.type,
        authority: params.authority,
        bodyMd: params.bodyMd,
        changeSummary: params.changeSummary,
      });
      return jsonResult({
        id: updated.id,
        slug: updated.slug,
        webUrl: webUrl(workspaceId, `/brain/${updated.slug}`),
      });
    },
  );

  tool(
    "delete_article",
    "Archive a Brain article so it stops appearing in active views. Indexed chunks are kept until an explicit purge.",
    {
      slug: z.string(),
    },
    async ({ slug }: { slug: string }) => {
      requireScope(sessionCtx, "brain:write");
      const result = await deleteArticle(actor, { workspaceId, slug });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "publish_article",
    "Open a private draft article so other workspace members can see it.",
    {
      slug: z.string(),
    },
    async ({ slug }: { slug: string }) => {
      requireScope(sessionCtx, "brain:write");
      const updated = await publishArticle(actor, { workspaceId, slug });
      return jsonResult({
        id: updated.id,
        slug: updated.slug,
        webUrl: webUrl(workspaceId, `/brain/${updated.slug}`),
      });
    },
  );

  tool(
    "return_article_to_draft",
    "Return a public Brain article to DRAFT so authorized draft managers can edit it. Archived articles cannot be returned.",
    {
      slug: z.string(),
    },
    async ({ slug }: { slug: string }) => {
      requireScope(sessionCtx, "brain:write");
      const updated = await returnArticleToDraft(actor, { workspaceId, slug });
      return jsonResult({
        id: updated.id,
        slug: updated.slug,
        authority: updated.authority,
        webUrl: webUrl(workspaceId, `/brain/${updated.slug}`),
      });
    },
  );

  tool(
    "create_discussion_thread",
    "Open a discussion thread on a Brain article. Posts an initial comment in the same call. User-only — agents cannot create threads.",
    {
      slug: z.string().describe("Article slug"),
      bodyMd: z.string().describe("Initial comment body"),
      targetType: z.enum(BRAIN_DISCUSSION_TARGET).optional().describe("ARTICLE | SECTION | LINE (default ARTICLE)"),
      targetRef: z.string().optional().describe("Section heading or line marker, when targetType is not ARTICLE"),
    },
    async (params: {
      slug: string;
      bodyMd: string;
      targetType?: typeof BRAIN_DISCUSSION_TARGET[number];
      targetRef?: string;
    }) => {
      requireScope(sessionCtx, "brain:write");
      const thread = await createDiscussionThread(actor, {
        workspaceId,
        slug: params.slug,
        bodyMd: params.bodyMd,
        targetType: params.targetType ?? "ARTICLE",
        targetRef: params.targetRef ?? null,
      });
      return jsonResult({
        id: thread.id,
        articleId: thread.articleId,
        webUrl: webUrl(workspaceId, `/brain/${params.slug}`),
      });
    },
  );

  tool(
    "add_discussion_comment",
    "Add a comment to an existing Brain discussion thread.",
    {
      threadId: z.string(),
      bodyMd: z.string(),
    },
    async ({ threadId, bodyMd }: { threadId: string; bodyMd: string }) => {
      requireScope(sessionCtx, "brain:write");
      const comment = await addDiscussionComment(actor, { workspaceId, threadId, bodyMd });
      return jsonResult({ id: comment.id, threadId: comment.threadId });
    },
  );

  tool(
    "resolve_discussion",
    "Mark a Brain discussion thread as RESOLVED.",
    {
      threadId: z.string(),
    },
    async ({ threadId }: { threadId: string }) => {
      requireScope(sessionCtx, "brain:write");
      const updated = await resolveDiscussionThread(actor, { workspaceId, threadId });
      return jsonResult({ id: updated.id, status: updated.status });
    },
  );

  // ===========================================================================
  // CYCLES
  // ===========================================================================

  tool(
    "list_cycles",
    "List all cycles (sprints / planning periods) in the workspace.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "cycles:read");
      const result = await listCycles(workspaceId, { take, skip });
      return jsonResult(result);
    },
  );

  tool(
    "get_cycle",
    "Get a cycle with its updates and allocations.",
    {
      cycleId: z.string(),
    },
    async ({ cycleId }: { cycleId: string }) => {
      requireScope(sessionCtx, "cycles:read");
      const cycle = await getCycle(workspaceId, cycleId);
      return jsonResult({
        ...cycle,
        webUrl: webUrl(workspaceId, `/cycles/${cycle.id}`),
      });
    },
  );

  tool(
    "list_cycle_updates",
    "List the updates posted by members during a cycle.",
    {
      cycleId: z.string(),
    },
    async ({ cycleId }: { cycleId: string }) => {
      requireScope(sessionCtx, "cycles:read");
      const updates = await listCycleUpdates(workspaceId, cycleId);
      return jsonResult(updates);
    },
  );

  tool(
    "list_allocations",
    "List point allocations made by members within a cycle.",
    {
      cycleId: z.string(),
    },
    async ({ cycleId }: { cycleId: string }) => {
      requireScope(sessionCtx, "cycles:read");
      const allocations = await listAllocations(workspaceId, cycleId);
      return jsonResult(allocations);
    },
  );

  tool(
    "create_cycle",
    "Create a new cycle. Facilitator/Admin only.",
    {
      name: z.string(),
      cadence: z.string().describe("e.g. 'monthly', 'quarterly'"),
      startDate: z.string().describe("ISO 8601 date"),
      endDate: z.string().describe("ISO 8601 date"),
      pointsPerUser: z.number().describe("Allocation budget per member (positive integer)"),
    },
    async (params: { name: string; cadence: string; startDate: string; endDate: string; pointsPerUser: number }) => {
      requireScope(sessionCtx, "cycles:write");
      const cycle = await createCycle(actor, {
        workspaceId,
        name: params.name,
        cadence: params.cadence,
        startDate: new Date(params.startDate),
        endDate: new Date(params.endDate),
        pointsPerUser: params.pointsPerUser,
      });
      return jsonResult({
        id: cycle.id,
        status: cycle.status,
        webUrl: webUrl(workspaceId, `/cycles/${cycle.id}`),
      });
    },
  );

  tool(
    "update_cycle",
    "Update a cycle's metadata or status. Facilitator/Admin only.",
    {
      cycleId: z.string(),
      name: z.string().optional(),
      cadence: z.string().optional(),
      status: z.enum(CYCLE_STATUS).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      pointsPerUser: z.number().optional(),
    },
    async (params: {
      cycleId: string;
      name?: string;
      cadence?: string;
      status?: typeof CYCLE_STATUS[number];
      startDate?: string;
      endDate?: string;
      pointsPerUser?: number;
    }) => {
      requireScope(sessionCtx, "cycles:write");
      const updated = await updateCycle(actor, {
        workspaceId,
        cycleId: params.cycleId,
        name: params.name,
        cadence: params.cadence,
        status: params.status,
        startDate: params.startDate ? new Date(params.startDate) : undefined,
        endDate: params.endDate ? new Date(params.endDate) : undefined,
        pointsPerUser: params.pointsPerUser,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/cycles/${updated.id}`),
      });
    },
  );

  // ===========================================================================
  // CIRCLES (org structure)
  // ===========================================================================

  tool(
    "list_circles",
    "List all circles (teams / domains) in the workspace, including their roles.",
    {},
    async () => {
      requireScope(sessionCtx, "circles:read");
      const circles = await listCircles(workspaceId);
      const simplified = circles.map((c) => ({
        id: c.id,
        name: c.name,
        purposeMd: c.purposeMd,
        domainMd: c.domainMd,
        maturityStage: c.maturityStage,
        parentCircleId: c.parentCircleId,
        roles: c.roles?.map((r) => ({ id: r.id, name: r.name, purposeMd: r.purposeMd })) ?? [],
      }));
      return jsonResult(simplified);
    },
  );

  // ===========================================================================
  // GOVERNANCE (constitution + policies)
  // ===========================================================================

  tool(
    "get_constitution",
    "Get the current workspace constitution. Also exposed as the corgtex://workspace/constitution resource for clients that prefer that interface.",
    {},
    async () => {
      requireScope(sessionCtx, "governance:read");
      const constitution = await getCurrentConstitution(workspaceId);
      return jsonResult({
        bodyMd: constitution?.bodyMd ?? null,
        version: constitution?.version ?? null,
        webUrl: webUrl(workspaceId, `/constitution`),
      });
    },
  );

  tool(
    "list_policies",
    "List the active policy corpus — every accepted proposal that became a workspace policy.",
    {},
    async () => {
      requireScope(sessionCtx, "governance:read");
      const policies = await listPolicyCorpus(actor, workspaceId);
      const simplified = policies.map((p) => ({
        id: p.id,
        title: p.title,
        bodyMd: p.bodyMd,
        acceptedAt: p.acceptedAt,
        proposal: p.proposal ? { id: p.proposal.id, title: p.proposal.title } : null,
        circle: p.circle ? { id: p.circle.id, name: p.circle.name } : null,
      }));
      return jsonResult(simplified);
    },
  );

  tool(
    "list_approval_policies",
    "List the approval policies that govern how proposals get accepted/rejected (modes, thresholds, decision windows).",
    {},
    async () => {
      requireScope(sessionCtx, "governance:read");
      const policies = await getApprovalPolicies(actor, workspaceId);
      return jsonResult(policies);
    },
  );

  // ===========================================================================
  // FINANCE
  // ===========================================================================

  tool(
    "list_spends",
    "List spend requests in the workspace.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "finance:read");
      const result = await listSpends(actor, workspaceId, { take, skip });
      const simplified = result.items.map((s) => ({
        id: s.id,
        amountCents: s.amountCents,
        currency: s.currency,
        category: s.category,
        description: s.description,
        status: s.status,
        version: s.version,
        vendor: s.vendor,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  tool(
    "create_spend",
    "Create and open a spend request in one call (legacy convenience). To create-then-review-then-open, use create_spend_draft + submit_spend instead.",
    {
      amountCents: z.number().describe("Amount in cents"),
      currency: z.string().describe("Currency code (e.g. USD)"),
      category: z.string().describe("Category of the spend"),
      description: z.string().describe("Description"),
      vendor: z.string().optional().describe("Vendor name"),
      requesterEmail: z.string().optional().describe("Optionally target a specific user via email"),
      requesterMemberId: z.string().optional().describe("Optionally target a specific active workspace member as requester"),
    },
    async (params: {
      amountCents: number;
      currency: string;
      category: string;
      description: string;
      vendor?: string;
      requesterEmail?: string;
      requesterMemberId?: string;
    }) => {
      requireScope(sessionCtx, "finance:write");
      const spend = await createSpend(actor, {
        workspaceId,
        amountCents: params.amountCents,
        currency: params.currency,
        category: params.category,
        description: params.description,
        vendor: params.vendor,
        requesterEmail: params.requesterEmail,
        requesterMemberId: params.requesterMemberId,
      });
      const submitted = await submitSpend(actor, { workspaceId, spendId: spend.id });
      return jsonResult({
        id: submitted.spendId,
        status: "OPEN",
        version: spend.version,
        webUrl: webUrl(workspaceId, `/finance/spend/${submitted.spendId}`),
      });
    },
  );

  tool(
    "create_spend_draft",
    "Create a spend request as a DRAFT (not yet submitted for approval). Pair with `submit_spend` when ready.",
    {
      amountCents: z.number(),
      currency: z.string(),
      category: z.string(),
      description: z.string(),
      vendor: z.string().optional(),
      requesterEmail: z.string().optional(),
      requesterMemberId: z.string().optional(),
      proposalId: z.string().optional(),
      ledgerAccountId: z.string().optional(),
    },
    async (params: {
      amountCents: number;
      currency: string;
      category: string;
      description: string;
      vendor?: string;
      requesterEmail?: string;
      requesterMemberId?: string;
      proposalId?: string;
      ledgerAccountId?: string;
    }) => {
      requireScope(sessionCtx, "finance:write");
      const spend = await createSpend(actor, {
        workspaceId,
        amountCents: params.amountCents,
        currency: params.currency,
        category: params.category,
        description: params.description,
        vendor: params.vendor,
        requesterEmail: params.requesterEmail,
        requesterMemberId: params.requesterMemberId,
        proposalId: params.proposalId,
        ledgerAccountId: params.ledgerAccountId,
      });
      return jsonResult({
        id: spend.id,
        status: spend.status,
        version: spend.version,
        webUrl: webUrl(workspaceId, `/finance/spend/${spend.id}`),
      });
    },
  );

  tool(
    "submit_spend",
    "Open a DRAFT spend request. Open spends are payable unless they receive an unresolved objection.",
    {
      spendId: z.string(),
    },
    async ({ spendId }: { spendId: string }) => {
      requireScope(sessionCtx, "finance:write");
      const submitted = await submitSpend(actor, { workspaceId, spendId });
      return jsonResult({
        id: submitted.spendId,
        status: "OPEN",
        webUrl: webUrl(workspaceId, `/finance/spend/${submitted.spendId}`),
      });
    },
  );

  tool(
    "update_spend",
    "Update a spend request. Draft edits keep draft-manager permissions; OPEN unpaid/unreconciled spend content edits require the connected requester and create a saved previous version.",
    {
      spendId: z.string(),
      amountCents: z.number().optional(),
      currency: z.string().optional(),
      category: z.string().optional(),
      description: z.string().optional(),
      vendor: z.string().nullable().optional(),
      ledgerAccountId: z.string().nullable().optional(),
    },
    async (params: {
      spendId: string;
      amountCents?: number;
      currency?: string;
      category?: string;
      description?: string;
      vendor?: string | null;
      ledgerAccountId?: string | null;
    }) => {
      requireScope(sessionCtx, "finance:write");
      const updated = await updateSpend(actor, {
        workspaceId,
        spendId: params.spendId,
        amountCents: params.amountCents,
        currency: params.currency,
        category: params.category,
        description: params.description,
        vendor: params.vendor,
        ledgerAccountId: params.ledgerAccountId,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        version: updated.version,
        webUrl: webUrl(workspaceId, `/finance/spend/${updated.id}`),
      });
    },
  );

  tool(
    "return_spend_to_draft",
    "Return an OPEN spend request to DRAFT so authorized draft managers can edit it. Paid, reconciled, resolved, or archived spend requests cannot be returned.",
    {
      spendId: z.string(),
    },
    async ({ spendId }: { spendId: string }) => {
      requireScope(sessionCtx, "finance:write");
      const updated = await returnSpendToDraft(actor, { workspaceId, spendId });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/finance/spend/${updated.id}`),
      });
    },
  );

  tool(
    "archive_spend",
    "Archive a spend request so it stops appearing in active finance views. Open or paid spend remains recoverable and auditable.",
    {
      spendId: z.string(),
    },
    async ({ spendId }: { spendId: string }) => {
      requireScope(sessionCtx, "finance:write");
      const result = await deleteSpend(actor, { workspaceId, spendId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "list_ledger_accounts",
    "List ledger accounts (checking, savings, credit, etc) in the workspace.",
    {},
    async () => {
      requireScope(sessionCtx, "finance:read");
      const result = await listLedgerAccounts(workspaceId, { take: 100 });
      const simplified = result.items.map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        type: a.type,
        balanceCents: a.balanceCents,
      }));
      return jsonResult(simplified);
    },
  );

  tool(
    "archive_ledger_account",
    "Archive a ledger account so it is hidden from active finance views. Ledger entries are preserved.",
    {
      accountId: z.string(),
    },
    async ({ accountId }: { accountId: string }) => {
      requireScope(sessionCtx, "finance:write");
      const result = await deleteLedgerAccount(actor, { workspaceId, accountId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "archive_artifact",
    "Archive any supported workspace artifact by entity type and id. Normal destructive actions should use archive, not purge.",
    {
      entityType: z.string(),
      entityId: z.string(),
      reason: z.string().optional(),
    },
    async ({ entityType, entityId, reason }: { entityType: string; entityId: string; reason?: string }) => {
      requireScope(sessionCtx, "archive:write");
      const archived = await archiveWorkspaceArtifact(actor, {
        workspaceId,
        entityType,
        entityId,
        reason: reason ?? null,
      });
      return jsonResult({ id: archived.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "list_archived_artifacts",
    "List archived workspace artifacts for recovery and audit. Admin/privileged archive scope only.",
    {
      entityType: z.string().optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      includeRestored: z.boolean().optional(),
      includePurged: z.boolean().optional(),
    },
    async (params: {
      entityType?: string;
      take?: number;
      skip?: number;
      includeRestored?: boolean;
      includePurged?: boolean;
    }) => {
      requireScope(sessionCtx, "archive:read");
      const items = await listArchivedWorkspaceArtifacts(actor, {
        workspaceId,
        entityType: params.entityType,
        take: params.take,
        skip: params.skip,
        includeRestored: params.includeRestored,
        includePurged: params.includePurged,
      });
      return jsonResult({ items, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "restore_artifact",
    "Restore an archived workspace artifact back to active views. Admin/privileged archive scope only.",
    {
      entityType: z.string(),
      entityId: z.string(),
    },
    async ({ entityType, entityId }: { entityType: string; entityId: string }) => {
      requireScope(sessionCtx, "archive:write");
      const restored = await restoreWorkspaceArtifact(actor, { workspaceId, entityType, entityId });
      return jsonResult({ id: restored.id, restored: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "purge_artifact",
    "Permanently purge an eligible archived workspace artifact. This is restricted, requires a reason, and refuses immutable finance/audit history.",
    {
      entityType: z.string(),
      entityId: z.string(),
      reason: z.string().min(1),
    },
    async ({ entityType, entityId, reason }: { entityType: string; entityId: string; reason: string }) => {
      requireScope(sessionCtx, "archive:write");
      const result = await purgeWorkspaceArtifact(actor, { workspaceId, entityType, entityId, reason });
      return jsonResult({ id: result.id, purged: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  tool(
    "list_ledger_transactions",
    "List ledger entries (transactions) for the workspace, optionally scoped to a single account. Returns most-recent-first.",
    {
      accountId: z.string().optional(),
      take: z.number().optional().describe("Default 50"),
    },
    async ({ accountId, take }: { accountId?: string; take?: number }) => {
      requireScope(sessionCtx, "finance:read");
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          workspaceId,
          ...(accountId ? { accountId } : {}),
        },
        orderBy: { occurredAt: "desc" },
        take: take ?? 50,
      });
      return jsonResult(entries);
    },
  );

  // ===========================================================================
  // RESOURCES
  // ===========================================================================

  server.resource(
    "constitution",
    "corgtex://workspace/constitution",
    { description: "The current version of the workspace constitution", mimeType: "text/markdown" },
    async () => {
      requireScope(sessionCtx, "governance:read");
      const constitution = await getCurrentConstitution(workspaceId);
      return {
        contents: [{
          uri: "corgtex://workspace/constitution",
          mimeType: "text/markdown",
          text: constitution?.bodyMd ?? "No constitution has been generated yet.",
        }],
      };
    },
  );

  server.resource(
    "policies",
    "corgtex://workspace/policies",
    { description: "Active policy corpus for the workspace", mimeType: "application/json" },
    async () => {
      requireScope(sessionCtx, "governance:read");
      const policies = await listPolicyCorpus(actor, workspaceId);
      const simplified = policies.map((p) => ({
        id: p.id,
        title: p.title,
        bodyMd: p.bodyMd,
        acceptedAt: p.acceptedAt,
        proposal: p.proposal ? { id: p.proposal.id, title: p.proposal.title } : null,
        circle: p.circle ? { id: p.circle.id, name: p.circle.name } : null,
      }));
      return {
        contents: [{
          uri: "corgtex://workspace/policies",
          mimeType: "application/json",
          text: JSON.stringify(simplified, null, 2),
        }],
      };
    },
  );

  server.resource(
    "context-map",
    "corgtex://map/process/current",
    { description: "Current living process context map for the workspace", mimeType: "application/json" },
    async () => {
      requireScope(sessionCtx, "context-graph:read");
      const data = await getContextMapData(actor, { workspaceId });
      return {
        contents: [{
          uri: "corgtex://map/process/current",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    },
  );

  return server;
}
