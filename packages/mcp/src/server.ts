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
  archiveProposal,
  submitProposal,
  publishProposal,
  listActions,
  createAction,
  updateAction,
  deleteAction,
  listTensions,
  createTension,
  updateTension,
  deleteTension,
  upvoteTension,
  listMembers,
  createMember,
  updateMember,
  deactivateMember,
  listMeetings,
  getMeeting,
  createMeeting,
  deleteMeeting,
  createArticle,
  updateArticle,
  getArticle,
  listArticles,
  deleteArticle,
  publishArticle,
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
  listSpends,
  listLedgerAccounts,
  listArchivedWorkspaceArtifacts,
  purgeWorkspaceArtifact,
  restoreWorkspaceArtifact,
} from "@corgtex/domain";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { processConversationTurn } from "@corgtex/agents";
import { prisma, env } from "@corgtex/shared";
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

const PROPOSAL_STATUS = ["DRAFT", "OPEN", "RESOLVED"] as const;
const ACTION_STATUS = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const;
const TENSION_STATUS = ["DRAFT", "OPEN", "RESOLVED"] as const;
const MEMBER_ROLE = ["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"] as const;
const CYCLE_STATUS = ["PLANNED", "OPEN_UPDATES", "OPEN_ALLOCATIONS", "REVIEW", "FINALIZED"] as const;
const BRAIN_ARTICLE_TYPE = [
  "PRODUCT", "ARCHITECTURE", "PROCESS", "RUNBOOK", "DECISION",
  "TEAM", "PERSON", "CUSTOMER", "INCIDENT", "PROJECT",
  "INTEGRATION", "PATTERN", "STRATEGY", "CULTURE", "GLOSSARY", "DIGEST",
] as const;
const BRAIN_ARTICLE_AUTHORITY = ["AUTHORITATIVE", "REFERENCE", "HISTORICAL", "DRAFT"] as const;
const BRAIN_DISCUSSION_TARGET = ["ARTICLE", "SECTION", "LINE"] as const;

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

  // ===========================================================================
  // CONVERSATION + SEARCH
  // ===========================================================================

  // @ts-expect-error — MCP SDK overload triggers TS2589 with zod schemas
  server.tool(
    "chat",
    "Send a message to Corgtex, the AI governance assistant. Returns Corgtex's response with full organizational knowledge context. This invokes an LLM call on the server side.",
    {
      message: z.string().describe("The message to send to Corgtex"),
    },
    async ({ message }: { message: string }) => {
      requireScope(sessionCtx, "conversations:write");
      const result = await processConversationTurn({
        workspaceId,
        sessionId: `mcp-${workspaceId}`,
        userId: "",
        agentKey: "assistant",
        userMessage: message,
      });
      return jsonResult({ assistantMessage: result.assistantMessage });
    },
  );

  server.tool(
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

  // ===========================================================================
  // WORKSPACE OVERVIEW
  // ===========================================================================

  server.tool(
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

  server.tool(
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
        listSpends(workspaceId, { take: 50 }),
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
  // PROPOSALS
  // ===========================================================================

  server.tool(
    "list_proposals",
    "List governance proposals in the workspace.",
    {
      take: z.number().optional().describe("Number of proposals to return (default 20)"),
      skip: z.number().optional().describe("Number of proposals to skip for pagination"),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "proposals:read");
      const result = await listProposals(actor, workspaceId, { take, skip });
      const simplified = result.items.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        summary: p.summary,
        author: p.author?.displayName ?? p.author?.email ?? "Unknown",
        createdAt: p.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  server.tool(
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
  server.tool(
    "create_proposal",
    "Create a new governance proposal draft. Starts in DRAFT and must be opened separately with the circle.",
    {
      title: z.string().describe("Proposal title"),
      bodyMd: z.string().describe("Proposal body in Markdown"),
      summary: z.string().optional().describe("Optional short summary"),
    },
    async ({ title, bodyMd, summary }: { title: string; bodyMd: string; summary?: string }) => {
      requireScope(sessionCtx, "proposals:write");
      const proposal = await createProposal(actor, { workspaceId, title, bodyMd, summary });
      return jsonResult({
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        webUrl: webUrl(workspaceId, `/proposals/${proposal.id}`),
      });
    },
  );

  server.tool(
    "update_proposal",
    "Update a draft proposal's title, body, summary, or owning circle. Only DRAFT proposals can be edited.",
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
        webUrl: webUrl(workspaceId, `/proposals/${updated.id}`),
      });
    },
  );

  server.tool(
    "submit_proposal",
    "Open a DRAFT proposal with the circle. Starts an approval flow per the workspace's approval policy.",
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

  server.tool(
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

  server.tool(
    "publish_proposal",
    "Publish a private draft proposal so other members can see it. Author-only — agents cannot publish on a user's behalf.",
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

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  server.tool(
    "list_actions",
    "List action items (todos / commitments) in the workspace.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "actions:read");
      const result = await listActions(actor, workspaceId, { take, skip });
      const simplified = result.items.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        author: a.author?.displayName ?? a.author?.email ?? "Unknown",
        assignee: a.assigneeMember?.user?.displayName ?? a.assigneeMember?.user?.email ?? null,
        dueAt: (a as Record<string, unknown>).dueAt ?? null,
        createdAt: a.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  server.tool(
    "create_action",
    "Create a new action item.",
    {
      title: z.string(),
      bodyMd: z.string().optional(),
    },
    async ({ title, bodyMd }: { title: string; bodyMd?: string }) => {
      requireScope(sessionCtx, "actions:write");
      const action = await createAction(actor, { workspaceId, title, bodyMd });
      return jsonResult({
        id: action.id,
        status: action.status,
        webUrl: webUrl(workspaceId, `/actions/${action.id}`),
      });
    },
  );

  server.tool(
    "update_action",
    "Update an action's title, body, status, circle, assignee, or due date. Pass only the fields you want to change.",
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
        webUrl: webUrl(workspaceId, `/actions/${updated.id}`),
      });
    },
  );

  server.tool(
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
        webUrl: webUrl(workspaceId, `/actions/${updated.id}`),
      });
    },
  );

  server.tool(
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

  server.tool(
    "list_tensions",
    "List tensions (issues/concerns raised by members).",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "tensions:read");
      const result = await listTensions(actor, workspaceId, { take, skip });
      const simplified = result.items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        author: t.author?.displayName ?? t.author?.email ?? "Unknown",
        assignee: t.assigneeMember?.user?.displayName ?? t.assigneeMember?.user?.email ?? null,
        createdAt: t.createdAt,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  server.tool(
    "create_tension",
    "File a new tension (issue/concern).",
    {
      title: z.string(),
      bodyMd: z.string().optional(),
    },
    async ({ title, bodyMd }: { title: string; bodyMd?: string }) => {
      requireScope(sessionCtx, "tensions:write");
      const tension = await createTension(actor, { workspaceId, title, bodyMd });
      return jsonResult({
        id: tension.id,
        status: tension.status,
        webUrl: webUrl(workspaceId, `/tensions/${tension.id}`),
      });
    },
  );

  server.tool(
    "update_tension",
    "Update a tension's title, body, status, circle, assignee, or priority. Pass only the fields you want to change.",
    {
      tensionId: z.string(),
      title: z.string().optional(),
      bodyMd: z.string().optional(),
      status: z.enum(TENSION_STATUS).optional(),
      circleId: z.string().optional(),
      assigneeMemberId: z.string().optional(),
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
        priority: params.priority,
        resolvedVia: params.resolvedVia,
      });
      return jsonResult({
        id: updated.id,
        status: updated.status,
        webUrl: webUrl(workspaceId, `/tensions/${updated.id}`),
      });
    },
  );

  server.tool(
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

  server.tool(
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
  // MEMBERS
  // ===========================================================================

  server.tool(
    "list_members",
    "List all active members of the workspace with their roles.",
    {},
    async () => {
      requireScope(sessionCtx, "members:read");
      const members = await listMembers(workspaceId);
      const simplified = members.map((m) => ({
        id: m.id,
        displayName: m.user.displayName,
        email: m.user.email,
        role: m.role,
        isActive: m.isActive,
      }));
      return jsonResult(simplified);
    },
  );

  server.tool(
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
      return jsonResult({
        id: result.member.id,
        userId: result.user.id,
        email: result.user.email,
        role: result.member.role,
        webUrl: webUrl(workspaceId, `/settings?tab=members`),
      });
    },
  );

  server.tool(
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

  server.tool(
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

  server.tool(
    "list_meetings",
    "List meetings in the workspace with their summaries.",
    {},
    async () => {
      requireScope(sessionCtx, "meetings:read");
      const meetings = await listMeetings(workspaceId);
      const simplified = meetings.map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
        recordedAt: m.recordedAt,
        hasSummary: Boolean(m.summaryMd),
        summaryPreview: m.summaryMd?.slice(0, 200) ?? null,
      }));
      return jsonResult(simplified);
    },
  );

  server.tool(
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

  server.tool(
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
      const meeting = await createMeeting(actor, {
        workspaceId,
        title: params.title ?? null,
        source: params.source,
        recordedAt: new Date(params.recordedAt),
        transcript: params.transcript ?? null,
        summaryMd: params.summaryMd ?? null,
        participantIds: params.participantIds ?? [],
      });
      return jsonResult({
        id: meeting.id,
        title: meeting.title,
        recordedAt: meeting.recordedAt,
        webUrl: webUrl(workspaceId, `/meetings/${meeting.id}`),
      });
    },
  );

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "update_article",
    "Update a Brain article. Pass `changeSummary` to label the version snapshot. The previous body is preserved as a version row.",
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

  server.tool(
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

  server.tool(
    "publish_article",
    "Publish a private draft article so other members can see it. Author-only — agents cannot publish on a user's behalf.",
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "list_spends",
    "List spend requests in the workspace.",
    {
      take: z.number().optional(),
      skip: z.number().optional(),
    },
    async ({ take, skip }: { take?: number; skip?: number }) => {
      requireScope(sessionCtx, "finance:read");
      const result = await listSpends(workspaceId, { take, skip });
      const simplified = result.items.map((s) => ({
        id: s.id,
        amountCents: s.amountCents,
        currency: s.currency,
        category: s.category,
        description: s.description,
        status: s.status,
        vendor: s.vendor,
      }));
      return jsonResult({ items: simplified, total: result.total });
    },
  );

  server.tool(
    "create_spend",
    "Create and open a spend request in one call (legacy convenience). To create-then-review-then-open, use create_spend_draft + submit_spend instead.",
    {
      amountCents: z.number().describe("Amount in cents"),
      currency: z.string().describe("Currency code (e.g. USD)"),
      category: z.string().describe("Category of the spend"),
      description: z.string().describe("Description"),
      vendor: z.string().optional().describe("Vendor name"),
      requesterEmail: z.string().optional().describe("Optionally target a specific user via email"),
    },
    async (params: {
      amountCents: number;
      currency: string;
      category: string;
      description: string;
      vendor?: string;
      requesterEmail?: string;
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
      });
      const submitted = await submitSpend(actor, { workspaceId, spendId: spend.id });
      return jsonResult({
        id: submitted.spendId,
        status: "OPEN",
        webUrl: webUrl(workspaceId, `/finance/spend/${submitted.spendId}`),
      });
    },
  );

  server.tool(
    "create_spend_draft",
    "Create a spend request as a DRAFT (not yet submitted for approval). Pair with `submit_spend` when ready.",
    {
      amountCents: z.number(),
      currency: z.string(),
      category: z.string(),
      description: z.string(),
      vendor: z.string().optional(),
      requesterEmail: z.string().optional(),
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
        proposalId: params.proposalId,
        ledgerAccountId: params.ledgerAccountId,
      });
      return jsonResult({
        id: spend.id,
        status: spend.status,
        webUrl: webUrl(workspaceId, `/finance/spend/${spend.id}`),
      });
    },
  );

  server.tool(
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

  server.tool(
    "archive_spend",
    "Archive a spend request so it stops appearing in active finance views. Submitted or paid spend remains recoverable and auditable.",
    {
      spendId: z.string(),
    },
    async ({ spendId }: { spendId: string }) => {
      requireScope(sessionCtx, "finance:write");
      const result = await deleteSpend(actor, { workspaceId, spendId });
      return jsonResult({ id: result.id, archived: true, webUrl: webUrl(workspaceId, `/audit?tab=archive`) });
    },
  );

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  return server;
}
