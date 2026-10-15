import { requireAgentOperation } from "@corgtex/domain";
import type { McpToolName } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";

export type AgentRouteCapability = {
  operation: McpToolName | null;
  feature?: "TOOL_LINKS" | "RELATIONSHIPS";
};

type RouteMethods = Readonly<Partial<Record<string, AgentRouteCapability>>>;

// Exact REST transport inventory. Null entries deliberately deny credential agents:
// their operations have no reviewed MCP equivalent or exercise additional authority.
// MCP JSON-RPC transport has separate authentication and is never authorized here.
export const AGENT_REST_ROUTE_CAPABILITIES = {
  "/[locale]/workspaces/[workspaceId]/maps/context": {
    GET: { operation: "get_selected_region_context" },
  },
  "/api/admin/customer-deployments/[deploymentId]/bootstrap": {
    POST: { operation: null },
  },
  "/api/admin/customer-deployments/[deploymentId]/health": {
    POST: { operation: null },
  },
  "/api/admin/customer-deployments/[deploymentId]/suspend": {
    POST: { operation: null },
  },
  "/api/admin/customer-deployments/[deploymentId]/upgrade": {
    POST: { operation: null },
  },
  "/api/admin/customer-deployments": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/admin/procurement/trials/[trialId]/suspend": {
    POST: { operation: null },
  },
  "/api/auth/sso/callback": {
    GET: { operation: null },
  },
  "/api/billing/checkout": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/billing/portal": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/ai-governance": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/context": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/feature-flags": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/integrations": {
    GET: { operation: null },
    PATCH: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/integrations/slack/callback": {
    GET: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/integrations/slack/install": {
    GET: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/meeting-recorders/microsoft/callback": {
    GET: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/meeting-recorders/microsoft/connect": {
    GET: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/members/[memberId]/access-link": {
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/members/[memberId]": {
    PATCH: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/members": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/operations": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/releases": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]": {
    GET: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/snapshot": {
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/support-connector": {
    POST: { operation: null },
  },
  "/api/control-plane/deployments/[deploymentId]/support-sessions": {
    POST: { operation: null },
  },
  "/api/control-plane/deployments": {
    GET: { operation: null },
  },
  "/api/control-plane/rollouts": {
    GET: { operation: null },
  },
  "/api/control-plane/self-serve": {
    GET: { operation: null },
  },
  "/api/control-plane/self-serve/support-sessions": {
    POST: { operation: null },
  },
  "/api/control-plane/self-serve/trials/[trialId]/approve": {
    POST: { operation: null },
  },
  "/api/control-plane/self-serve/trials/[trialId]/reject": {
    POST: { operation: null },
  },
  "/api/control-plane/workspaces": {
    GET: { operation: null },
  },
  "/api/enterprise-app-sessions/introspect": {
    POST: { operation: null },
  },
  "/api/integrations/[provider]/callback": {
    GET: { operation: null },
  },
  "/api/integrations/[provider]/connect": {
    GET: { operation: null },
  },
  "/api/integrations/connections/[connectionId]/disconnect": {
    POST: { operation: null },
  },
  "/api/integrations/slack/callback": {
    GET: { operation: null },
  },
  "/api/integrations/slack/install": {
    GET: { operation: null },
  },
  "/api/newspaper/click/[token]": {
    GET: { operation: null },
  },
  "/api/oauth/authorize": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/session": {
    GET: { operation: null },
  },
  "/api/user/avatar": {
    POST: { operation: null },
    DELETE: { operation: null },
  },
  "/api/user/notifications/preferences": {
    GET: { operation: null },
    PUT: { operation: null },
  },
  "/api/user/password": {
    POST: { operation: null },
  },
  "/api/user/profile": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/user/sessions": {
    GET: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/actions/[actionId]": {
    PATCH: { operation: "update_action" },
    DELETE: { operation: "delete_action" },
  },
  "/api/workspaces/[workspaceId]/actions/duplicates": {
    GET: { operation: "list_actions" },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/actions": {
    GET: { operation: "list_actions" },
    POST: { operation: "create_action" },
  },
  "/api/workspaces/[workspaceId]/agent-credentials/[credentialId]/revoke": {
    POST: { operation: "revoke_agent_credential" },
  },
  "/api/workspaces/[workspaceId]/agent-credentials/[credentialId]/rotate": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/agent-credentials/[credentialId]": {
    PATCH: { operation: "update_agent_credential_scopes" },
  },
  "/api/workspaces/[workspaceId]/agent-credentials": {
    GET: { operation: "list_agent_credentials" },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/agent-identities/[agentId]/behavior": {
    GET: { operation: null },
    PUT: { operation: null },
  },
  "/api/workspaces/[workspaceId]/agent-identities/[agentId]": {
    GET: { operation: null },
    PATCH: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/agent-identities": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/agent-runs": {
    GET: { operation: "list_agent_runs" },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/ai-workspace-selection": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/approvals/[flowId]/decisions": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/approvals/[flowId]/objections/[objectionId]/resolve": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/approvals/[flowId]/objections": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/archive/[entityType]/[entityId]/purge": {
    POST: { operation: "purge_artifact" },
  },
  "/api/workspaces/[workspaceId]/archive/[entityType]/[entityId]/restore": {
    POST: { operation: "restore_artifact" },
  },
  "/api/workspaces/[workspaceId]/archive": {
    GET: { operation: "list_archived_artifacts" },
    POST: { operation: "archive_artifact" },
  },
  "/api/workspaces/[workspaceId]/history-recovery": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/articles/[slug]/discussions/[threadId]/comments": {
    POST: { operation: "add_discussion_comment" },
  },
  "/api/workspaces/[workspaceId]/brain/articles/[slug]/discussions/[threadId]": {
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/articles/[slug]/discussions": {
    GET: { operation: "get_article" },
    POST: { operation: "create_discussion_thread" },
  },
  "/api/workspaces/[workspaceId]/brain/articles/[slug]": {
    GET: { operation: "get_article" },
    PATCH: { operation: "update_article" },
    // This route can also remove backing sources and documents.
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/articles/[slug]/versions": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/articles": {
    GET: { operation: "list_articles" },
    POST: { operation: "create_article" },
  },
  "/api/workspaces/[workspaceId]/brain/ask": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/search": {
    GET: { operation: "search_knowledge" },
  },
  "/api/workspaces/[workspaceId]/brain/sources/[sourceId]/file": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/sources/[sourceId]": {
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/sources": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/sources/upload": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/brain/status": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/build-artifacts/[artifactId]/assets/[assetId]": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/build-artifacts/[artifactId]/assets": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/build-artifacts/[artifactId]/revoke-public": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/build-artifacts/[artifactId]": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/build-artifacts": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog/[catalogItemId]/favorite": {
    POST: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog/[catalogItemId]": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog/requests/[requestId]/approve": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog/requests/[requestId]/reject": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog/requests": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/catalog": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/chat/attachments": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/check-ins": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/circles/[circleId]": {
    PATCH: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/circles": {
    GET: { operation: "list_circles" },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/conversations/[conversationId]/brain": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/information-categories": {
    PATCH: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/conversations/[conversationId]": {
    GET: { operation: null },
    POST: { operation: null },
    PATCH: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/conversations": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/data-sources/[sourceId]": {
    // This detail endpoint includes sync logs absent from the MCP list operation.
    GET: { operation: null },
    PATCH: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/data-sources/[sourceId]/sync": {
    POST: { operation: "sync_data_source" },
  },
  "/api/workspaces/[workspaceId]/data-sources/[sourceId]/test": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/data-sources": {
    GET: { operation: "list_data_sources" },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/data-sources/test": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/data-sources/text-ingest": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/deliberation-entries/[entryId]/resolve": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/deliberation-entries/[entryId]": {
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/deliberation-entries": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/documents/[documentId]": {
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/documents": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]/health": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]/releases": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]": {
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]/runtime": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]/sessions": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps/[installationId]/surfaces": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/enterprise-apps": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/events/[eventId]/replay": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/events": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/execution-requests/[requestId]": {
    GET: { operation: "get_execution_packet" },
  },
  "/api/workspaces/[workspaceId]/execution-requests/[requestId]/submit-result": {
    POST: { operation: "submit_execution_result" },
  },
  "/api/workspaces/[workspaceId]/execution-requests": {
    GET: { operation: null },
    POST: { operation: "create_execution_request" },
  },
  "/api/workspaces/[workspaceId]/external-content-sources/[sourceId]/sync": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/external-content-sources": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/external-mcp-connections": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/external-resources": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/contributions": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/history-archive": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/imports/[batchId]": {
    GET: { operation: null },
    POST: { operation: null },
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/imports": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/payables/[entryId]/confirm": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/projects": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/finance/readiness": {
    GET: { operation: "get_finance_readiness" },
  },
  "/api/workspaces/[workspaceId]/intercom-token": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/mcp-connections": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-audio-assets": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-recorders/config": {
    GET: { operation: null },
    PUT: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-transcript-sources/[provider]/backfill": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-transcript-sources/[provider]/connect": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-transcript-sources/[provider]/import": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-transcript-sources/batches/[batchId]/retry": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meeting-transcript-sources": {
    GET: { operation: null },
  },
  // Native CRM presentation still requires current source authority at delivery;
  // this transport policy grants only the canonical relationships read operation.
  "/api/workspaces/[workspaceId]/leads/archive": {
    GET: { operation: "list_relationship_accounts", feature: "RELATIONSHIPS" },
  },
  "/api/workspaces/[workspaceId]/meetings/[meetingId]/recording/cancel": {
    // REST returns raw recorder details that MCP deliberately redacts.
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meetings/[meetingId]/recording/schedule": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meetings/[meetingId]": {
    DELETE: { operation: "delete_meeting" },
  },
  "/api/workspaces/[workspaceId]/meetings/invite": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meetings": {
    GET: { operation: "list_meetings" },
    POST: { operation: "upload_meeting" },
  },
  "/api/workspaces/[workspaceId]/meetings/schedule": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/meetings/transcript": {
    POST: { operation: "upload_meeting" },
  },
  "/api/workspaces/[workspaceId]/members/[memberId]": {
    PATCH: { operation: "update_member" },
    DELETE: { operation: "deactivate_member" },
  },
  "/api/workspaces/[workspaceId]/members/invite-requests/[requestId]": {
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/members/invite-requests": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/members": {
    GET: { operation: "list_members" },
    POST: { operation: "create_member" },
  },
  "/api/workspaces/[workspaceId]/mobile-analytics": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/oauth-apps": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/onboarding/google-drive": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/onboarding/meeting-recorder": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/onboarding/meeting-transcript-sources": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/onboarding": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/product-feedback": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/proposals/[proposalId]/archive": {
    POST: { operation: "archive_proposal" },
  },
  "/api/workspaces/[workspaceId]/proposals/[proposalId]/resolve": {
    POST: { operation: "resolve_proposal" },
  },
  "/api/workspaces/[workspaceId]/proposals/[proposalId]": {
    PATCH: { operation: "update_proposal" },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/proposals/[proposalId]/submit": {
    POST: { operation: "submit_proposal" },
  },
  "/api/workspaces/[workspaceId]/proposals": {
    GET: { operation: "list_proposals" },
    // The sourceTensionId branch reads a Tension before creating a Proposal.
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/roles/[roleId]/assignments": {
    GET: { operation: null },
    POST: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/roles/[roleId]": {
    PATCH: { operation: null },
    DELETE: { operation: null },
  },
  "/api/workspaces/[workspaceId]/roles": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/support-access/requests": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/support-access": {
    GET: { operation: null },
    PUT: { operation: null },
  },
  "/api/workspaces/[workspaceId]/support-configuration": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/support-setup": {
    GET: { operation: null },
    PATCH: { operation: null },
  },
  "/api/workspaces/[workspaceId]/tensions/[tensionId]": {
    PATCH: { operation: "update_tension" },
    DELETE: { operation: "delete_tension" },
  },
  "/api/workspaces/[workspaceId]/tensions": {
    GET: { operation: "list_tensions" },
    POST: { operation: "create_tension" },
  },
  "/api/workspaces/[workspaceId]/tool-links/[toolLinkId]/reveal": {
    POST: { operation: "reveal_tool_link_credential", feature: "TOOL_LINKS" },
  },
  "/api/workspaces/[workspaceId]/tool-links/[toolLinkId]": {
    GET: { operation: "list_tool_links", feature: "TOOL_LINKS" },
    PATCH: { operation: "upsert_tool_link", feature: "TOOL_LINKS" },
    DELETE: { operation: "archive_tool_link", feature: "TOOL_LINKS" },
  },
  "/api/workspaces/[workspaceId]/tool-links": {
    GET: { operation: "list_tool_links", feature: "TOOL_LINKS" },
    POST: { operation: "upsert_tool_link", feature: "TOOL_LINKS" },
  },
  "/api/workspaces/[workspaceId]/webhooks": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/work-item-versions": {
    GET: { operation: null },
  },
  "/api/workspaces/[workspaceId]/workflow-jobs/[workflowJobId]/replay": {
    POST: { operation: null },
  },
  "/api/workspaces/[workspaceId]/workflow-jobs": {
    GET: { operation: "list_runtime_jobs" },
  },
  "/api/workspaces": {
    GET: { operation: null },
    POST: { operation: null },
  },
  "/public/build-artifacts/[publicToken]/assets/[assetId]": {
    GET: { operation: null },
  },
} as const satisfies Readonly<Record<string, RouteMethods>>;

const routeEntries = Object.entries(AGENT_REST_ROUTE_CAPABILITIES)
  .map(([template, methods]) => ({
    template,
    methods: methods as RouteMethods,
    segments: template.split("/"),
  }))
  .sort((left, right) => {
    // Match Next route precedence before choosing the HTTP method. A static route
    // cannot inherit an allowed method from a sibling dynamic-ID route.
    for (let index = 0; index < Math.min(left.segments.length, right.segments.length); index++) {
      const leftDynamic = left.segments[index].startsWith("[");
      const rightDynamic = right.segments[index].startsWith("[");
      if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
    }
    return right.segments.length - left.segments.length;
  });

export function getAgentRouteCapability(method: string, pathname: string): AgentRouteCapability | null {
  // Only the canonical pathname is accepted; query strings and URL decoding are
  // the HTTP router's responsibility. Do not turn encoded separators into IDs.
  if (!pathname.startsWith("/") || /[?#\\]/.test(pathname)) return null;
  const segments = pathname.split("/");
  if (segments.some(segment => /%2f|%5c/i.test(segment))) return null;
  const route = routeEntries.find(entry => entry.segments.length === segments.length
    && entry.segments.every((segment, index) => segment.startsWith("[")
      ? segments[index].length > 0
      : segment === segments[index]));
  return route && Object.prototype.hasOwnProperty.call(route.methods, method) ? route.methods[method] ?? null : null;
}

export function getAgentRouteOperation(method: string, pathname: string): McpToolName | null {
  return getAgentRouteCapability(method, pathname)?.operation ?? null;
}

export function requireAgentRouteCapability(
  actor: AppActor,
  request: { method: string; nextUrl: { pathname: string } },
  options: { deferToolLinkScope?: boolean } = {},
) {
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return;
  const capability = getAgentRouteCapability(request.method, request.nextUrl.pathname);
  if (capability?.operation && capability.feature === "TOOL_LINKS" && options.deferToolLinkScope) return;
  // Undeclared or explicitly denied routes use an undeclared operation, so the
  // same domain guard rejects them even when the credential grants broad scopes.
  requireAgentOperation(actor, capability?.operation ?? `rest:${request.method}:${request.nextUrl.pathname}`);
}
