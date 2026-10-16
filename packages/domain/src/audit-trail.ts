import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { Prisma, EventStatus, WorkflowJobStatus } from "@prisma/client";
import { WorkItemReadRelease } from "./work-item-readable-page";
import { redactAgentRunContent } from "./agent-runs";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { mergeLineageInputRoot, withArtifactCountReleaseSnapshot, captureArtifactInputProof, isArtifactInputProofReadable, isLineageKind, readableArtifactIds, sealArtifactInputActor, type LineageKind, type LineageRoot } from "./source-lineage";

export async function recordAudit(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    action: string;
    entityType: string;
    entityId: string;
    meta?: Record<string, unknown>;
  }
) {
  return tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      meta: params.meta ? (params.meta as Prisma.InputJsonObject) : Prisma.DbNull,
    },
  });
}

// Only server-defined operation vocabulary is an operational fact. Historical
// free text is never certified by the current target's content receipt.
const AUDIT_OPERATIONS: Partial<Record<LineageKind, readonly string[]>> = {
  Action: ["action.checklist_item.created", "action.checklist_item.deleted", "action.checklist_item.updated", "action.completed", "action.created", "action.duplicate_resolved", "action.published", "action.returned_to_draft", "action.updated", "create_action"],
  AdviceRequest: ["advice.request.completed", "advice.request.withdrawn", "advice.requested"],
  AgentRun: ["agentRun.feedbackSubmitted"],
  ApprovalFlow: ["approval.decision_recorded", "approval.finalized", "approval.objection_created", "approval.objection_resolved", "approval.withdrawn"],
  BrainArticle: ["brain-article.created", "brain-article.published", "brain-article.regenerated", "brain-article.returned_to_draft", "brain-article.updated", "brain-article.variant.created"],
  BrainSource: ["brain-source.created", "brain-source.reconciled", "brain-source.updated"],
  BuildArtifact: ["build_artifact.created", "build_artifact.updated", "build_artifact.public_revoked"],
  BuildArtifactAsset: ["build_artifact_asset.created", "managed_release.inventory_frozen"],
  Circle: ["circle.created", "circle.updated"],
  ContextGraphObject: ["context-graph.object.upserted"],
  ContextGraphProposedDiff: ["context-graph.diff.applied", "context-graph.diff.approved", "context-graph.diff.edited", "context-graph.diff.proposed"],
  ContextGraphRelationship: ["context-graph.relationship.upserted"],
  ContextMapView: ["context-graph.map.imported", "context-map.layout.updated", "context-map.view.personal.created"],
  CrmAccount: ["crm.account.converted_to_client", "crm.account.created", "crm.account.customer_lifecycle_registered", "crm.account.updated"],
  CrmActivity: ["crm.activity.completed", "crm.activity.updated"],
  CrmCommunicationSuggestion: ["crm.communication_suggestion.created", "crm.communication_suggestion.declined", "crm.communication_suggestion.failed", "crm.communication_suggestion.requested", "crm.communication_suggestion.sent", "crm.communication_suggestion.updated"],
  CrmContact: ["crm.contact.created", "crm.contact.updated"],
  CrmDeal: ["crm.deal.created", "crm.deal.updated"],
  DeliberationEntry: ["deliberation.entry_posted", "deliberation.entry_resolved", "deliberation.entry_updated"],
  Document: ["document.created", "document.updated"],
  ExecutionRequest: ["execution_request.created", "execution_result.submitted"],
  ExternalContentSource: ["external-content-source.selected", "external-content-source.sync_requested"],
  FinanceImportBatch: ["finance-report-import.applied", "finance-report-import.extracted", "finance-report-import.extraction-failed", "finance-report-import.proposed", "finance-report-import.reconciled", "finance-report-import.uploaded"],
  FinanceImportCandidate: ["finance-report-import.candidate-edited"],
  Goal: ["goal.created", "goal.updated", "workspace-artifact.archived"],
  Meeting: ["meeting.agenda.edited", "meeting.created", "meeting.intelligence-regeneration-requested", "meeting.processed_content_updated", "meeting.scheduled", "meeting.transcript-uploaded", "meeting.updated", "meeting_follow_up_review_posted"],
  MeetingAudioAsset: ["meeting-audio.ingested", "meeting-audio.uploaded"],
  MeetingSeries: ["meeting-invite.imported", "meeting-series.created", "meeting-series.recorder-url-updated"],
  Member: ["member.access_link.created", "member.created", "member.deactivated", "member.merged", "member.reactivated", "member.updated", "procurement_trial.admin_created"],
  Proposal: ["proposal.created", "proposal.created_from_tension", "proposal.opened", "proposal.published", "proposal.reopened", "proposal.resolved", "proposal.returned_to_draft", "proposal.support_reopened_resolved", "proposal.updated", "workspace-artifact.archived"],
  Role: ["role.created", "role.updated", "workspace-artifact.archived"],
  RoleAssignment: ["role.assigned", "role.unassigned"],
  Tension: ["tension.created", "tension.published", "tension.returned_to_draft", "tension.updated"],
  WorkspaceToolLink: ["tool_link.created", "tool_link.credential_revealed", "tool_link.updated"],
};
const ARCHIVE_OPERATIONS = new Set(["workspace-artifact.archived", "workspace-artifact.restored", "workspace-artifact.purged"]);
const EVENT_OPERATIONS: Partial<Record<LineageKind, readonly string[]>> = {
  Action: ["action.assigned", "action.checklist_item.created", "action.checklist_item.deleted", "action.checklist_item.updated", "action.created", "action.published", "action.returned_to_draft", "action.updated"],
  AdviceRequest: ["advice.reminder_due", "advice.request.completed", "advice.request.withdrawn", "advice.requested"],
  AgentIdentity: ["agent-identity.created", "agent-identity.deactivated"],
  ApprovalFlow: ["approval.decision_recorded", "approval.finalized", "approval.objection_created", "approval.objection_resolved"],
  BrainArticle: ["brain-article.created", "brain-article.published", "brain-article.returned_to_draft", "brain-article.updated", "source-lineage.changed"],
  BrainSource: ["brain-source.created", "source-lineage.changed"],
  CheckIn: ["checkin.response_received", "checkin.skipped"],
  Circle: ["circle.created"],
  CircleAgentAssignment: ["agent-identity.circle-assigned", "agent-identity.circle-unassigned"],
  ContextGraphProposedDiff: ["context-graph.diff.applied"],
  ContextMapView: ["context-graph.map.imported"],
  CrmAccount: ["crm.account.converted_to_client", "crm.account.created", "crm.account.customer_lifecycle_registered"],
  CrmContact: ["crm.contact.created"],
  CrmConversation: ["crm.inquiry.acknowledgement_sent", "crm.inquiry.captured"],
  CrmDeal: ["crm.deal.created"],
  CrmProspectWorkspace: ["crm.prospect_workspace.provisioned"],
  CrmQualification: ["crm.qualification.approved", "crm.qualification.rejected", "crm.qualification.submitted"],
  DeliberationEntry: ["advice.reply_posted", "deliberation.entry_posted", "deliberation.entry_updated"],
  DemoLead: ["demo-lead.captured"],
  Document: ["document.created", "document.updated"],
  FinanceImportBatch: ["finance-report-import.extracted", "finance-report-import.proposed", "finance-report-import.reconciled", "finance-report-import.uploaded"],
  Goal: ["goal.created", "goal.updated"],
  GoalLink: ["goal-link.created"],
  Meeting: ["meeting.created", "meeting.processed-content-updated", "meeting.scheduled", "meeting.transcript-uploaded"],
  Member: ["member.created", "member.deactivated", "member.merged", "member.reactivated", "member.updated"],
  Proposal: ["proposal.created", "proposal.opened", "proposal.published", "proposal.reopened", "proposal.returned_to_draft", "proposal.support_reopened_resolved", "proposal.updated"],
  Role: ["role.created", "role.updated"],
  RoleAssignment: ["role.assigned", "role.assignment.updated", "role.unassigned"],
  Tension: ["tension.created", "tension.published", "tension.returned_to_draft", "tension.updated"],
};
const JOB_OPERATIONS = new Set(["agent.action-extraction", "agent.brain-absorb", "agent.checkin-analysis", "agent.constitution-synthesis", "agent.constitution-update-trigger", "agent.crm-email-extraction", "agent.crm-lead-enrichment", "agent.inbox-triage", "agent.meeting-summary", "agent.role-onboarding-intro", "context-graph.sync", "email.crm-inquiry-acknowledgement", "email.demo-welcome-newspaper", "finance-report-import.extract", "finance-report-import.interpret", "governance.score", "knowledge.sync.action", "knowledge.sync.brain-article", "knowledge.sync.circle", "knowledge.sync.document", "knowledge.sync.event", "knowledge.sync.meeting", "knowledge.sync.proposal", "knowledge.sync.role", "knowledge.sync.tension", "meeting.insights.extract", "meeting.summary.post", "source-lineage.rebuild"]);
const EVENT_STATUSES = new Set<string>(Object.values(EventStatus));
const JOB_STATUSES = new Set<string>(Object.values(WorkflowJobStatus));
const AUDIT_SCAN_LIMIT = 5000;

const AUDIT_SELECT = { id: true, workspaceId: true, actorUserId: true, action: true, entityType: true,
  entityId: true, createdAt: true } as const;
type AuditOperationalRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;
function auditOperationalFields(row: AuditOperationalRow) {
  return { id: row.id, workspaceId: row.workspaceId, actorUserId: row.actorUserId,
    action: row.action, entityType: row.entityType, entityId: row.entityId,
    createdAt: row.createdAt, meta: null };
}

async function captureAuditTarget(actor: AppActor, workspaceId: string, kind: string, id: string, snapshot?: Record<string, unknown>): Promise<LineageRoot[] | null> {
  if (!isLineageKind(kind)) return null;
  try { return await captureArtifactInputProof(actor, workspaceId, [{ kind, id, ...(snapshot ? { snapshot } : {}) }]); }
  catch (error) {
    if (error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "PERMISSION_CHANGED"].includes(error.code)) return null;
    throw error;
  }
}

export async function listAuditLogs(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  entityType?: string;
  entityId?: string;
  action?: string;
  actorUserId?: string;
}) {
  sealArtifactInputActor(actor);
  opts = opts ? { ...opts } : undefined;
  await requireWorkspaceMembership({ actor, workspaceId });
  if (opts?.entityType && !isLineageKind(opts.entityType)) return [];
  if (opts?.entityType && opts.entityId && !await captureAuditTarget(actor, workspaceId, opts.entityType, opts.entityId)) return [];
  const take = Math.max(0, Math.min(opts?.take ?? 50, AUDIT_SCAN_LIMIT));
  const release = new WorkItemReadRelease(actor, workspaceId);
  const visible = [];
  let after: AuditOperationalRow | undefined;
  while (visible.length < take) {
    const rows = await prisma.auditLog.findMany({
      where: { workspaceId,
        ...(opts?.entityType ? { entityType: opts.entityType } : {}),
        ...(opts?.entityId ? { entityId: opts.entityId } : {}),
        ...(opts?.action ? { action: { contains: opts.action } } : {}),
        ...(opts?.actorUserId ? { actorUserId: opts.actorUserId } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      select: AUDIT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
    });
    invariant(rows.length <= 100 && (!rows.length || rows.at(-1)!.id !== after?.id),
      503, "SOURCE_READ_SCAN_CHANGED", "Audit page changed; retry.");
    // Denied candidates do not consume the visible sample or accumulate bodies.
    const proofs = new Map<string, LineageRoot[] | null>();
    for (const row of rows) {
      if (!isLineageKind(row.entityType) || !(AUDIT_OPERATIONS[row.entityType]?.includes(row.action) || ARCHIVE_OPERATIONS.has(row.action))) continue;
      const key = JSON.stringify([row.entityType, row.entityId]);
      if (!proofs.has(key)) proofs.set(key, await release.observeRead(() => captureAuditTarget(actor, workspaceId, row.entityType, row.entityId)));
      const roots = proofs.get(key);
      if (!roots) continue;
      release.add(roots);
      visible.push(auditOperationalFields(row));
      if (visible.length === take) break;
    }
    if (rows.length < 100) break;
    after = rows.at(-1);
  }
  await requireWorkspaceMembership({ actor, workspaceId });
  return release.finish(visible);
}

export async function getEntityTimeline(actor: AppActor, workspaceId: string, entityType: string, entityId: string) {
  sealArtifactInputActor(actor);
  await requireWorkspaceMembership({ actor, workspaceId });
  const empty = { auditLogs: [], relatedEvents: [] };
  const roots = await captureAuditTarget(actor, workspaceId, entityType, entityId);
  if (!roots || !isLineageKind(entityType)) return empty;
  const [auditLogs, relatedEvents] = await Promise.all([
    prisma.auditLog.findMany({ where: { workspaceId, entityType, entityId }, select: AUDIT_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: AUDIT_SCAN_LIMIT + 1 }),
    prisma.event.findMany({ where: { workspaceId, aggregateType: entityType, aggregateId: entityId },
      select: { id: true, type: true, status: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: AUDIT_SCAN_LIMIT + 1 }),
  ]);
  invariant(auditLogs.length <= AUDIT_SCAN_LIMIT && relatedEvents.length <= AUDIT_SCAN_LIMIT,
    409, "SOURCE_READ_SCAN_LIMIT", "Timeline exceeds the safe scan limit.");
  const visibleEvents = relatedEvents.filter(event => EVENT_OPERATIONS[entityType]?.includes(event.type) && EVENT_STATUSES.has(event.status));
  // One bound across all events; a per-event nested take would multiply the scan.
  const jobs = visibleEvents.length ? await prisma.workflowJob.findMany({
    where: { workspaceId, eventId: { in: visibleEvents.map(event => event.id) } },
    select: { id: true, eventId: true, type: true, status: true, completedAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: AUDIT_SCAN_LIMIT + 1,
  }) : [];
  invariant(jobs.length <= AUDIT_SCAN_LIMIT, 409, "SOURCE_READ_SCAN_LIMIT", "Timeline exceeds the safe scan limit.");
  const admittedJobs = [];
  for (const job of jobs) {
    if (!JOB_OPERATIONS.has(job.type) || !JOB_STATUSES.has(job.status)) continue;
    const jobRoots = await captureAuditTarget(actor, workspaceId, "WorkflowJobInput", job.id, job);
    if (jobRoots) admittedJobs.push({ row: job, roots: jobRoots });
  }
  await requireWorkspaceMembership({ actor, workspaceId });
  const currentJobs: typeof jobs = [];
  for (const job of admittedJobs) if (await isArtifactInputProofReadable(actor, workspaceId, job.roots)) currentJobs.push(job.row);
  if (!await isArtifactInputProofReadable(actor, workspaceId, roots)) return empty;
  return { auditLogs: auditLogs.filter(row => AUDIT_OPERATIONS[entityType]?.includes(row.action) || ARCHIVE_OPERATIONS.has(row.action)).map(auditOperationalFields),
    relatedEvents: visibleEvents.map(event => ({ id: event.id, type: event.type, status: event.status, createdAt: event.createdAt,
      jobs: currentJobs.filter(job => job.eventId === event.id).map(job => ({ id: job.id, type: job.type, status: job.status, completedAt: job.completedAt })), payload: null })) };

}

export async function getAgentRunTrace(actor: AppActor, workspaceId: string, agentRunId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const run = await prisma.agentRun.findFirst({
    where: { id: agentRunId, workspaceId },
    include: {
      steps: {
        orderBy: { createdAt: "asc" },
      },
      toolCalls: {
        orderBy: { createdAt: "asc" },
      },
      modelUsage: {
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          latencyMs: true,
          estimatedCostUsd: true,
          billableCostUsd: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return run ? redactAgentRunContent(actor, workspaceId, run) : null;
}

export async function getModelUsageSummary(actor: AppActor, workspaceId: string, opts?: {
  periodDays?: number;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  invariant(actor.kind === "user" && membership?.role === "ADMIN", 403, "FORBIDDEN", "Model usage costs require a current workspace administrator.");

  const periodDays = opts?.periodDays ?? 30;
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  // Aggregate by model
  const byModel = new Map<string, {
    provider: string;
    model: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  // Aggregate by agent
  const byAgent = new Map<string, {
    agentKey: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  // Aggregate by day
  const byDay = new Map<string, {
    date: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  const roots = new Map<string, LineageRoot>();
  let afterId: string | undefined;
  let totalCalls = 0;
  for (;;) {
    const candidates = await prisma.modelUsage.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        ...(afterId ? {id: {gt: afterId}} : {}),
      },
      select: {
        id: true,
        workspaceId: true,
        agentRunId: true,
        provider: true,
        model: true,
        taskType: true,
        inputTokens: true,
        outputTokens: true,
        latencyMs: true,
        estimatedCostUsd: true,
        billableCostUsd: true,
        createdAt: true,
        agentRun: true,
      },
      orderBy: {id: "asc"},
      take: 100,
    });
    const costRows = candidates.map(({ id, workspaceId: rowWorkspaceId, estimatedCostUsd, billableCostUsd, createdAt }) =>
      ({ id, workspaceId: rowWorkspaceId, estimatedCostUsd, billableCostUsd, createdAt }));
    const readableCosts = await readableArtifactIds(actor, workspaceId, "ModelUsageCost", costRows);
    const runs = [...new Map(candidates.flatMap(row => row.agentRun ? [[row.agentRun.id, row.agentRun] as const] : [])).values()];
    const readableRuns = await readableArtifactIds(actor, workspaceId, "AgentRun", runs);
    const usages = candidates.filter(row => readableCosts.has(row.id)
      && (!row.agentRunId || (row.agentRun?.id === row.agentRunId && readableRuns.has(row.agentRunId))));

    if (usages.length) {
      const proof = await captureArtifactInputProof(actor, workspaceId, usages.flatMap(usage => [
        {kind: "ModelUsageCost" as const, id: usage.id, snapshot: usage},
        ...(usage.agentRun ? [{kind: "AgentRun" as const, id: usage.agentRun.id, snapshot: usage.agentRun}] : []),
      ]));
      for (const root of proof) {
        const key = `${root.kind}:${root.id}`;
        roots.set(key, mergeLineageInputRoot(roots.get(key), root));
      }
    }
    totalCalls += usages.length;
    for (const usage of usages) {
      const costUsd = parseCost(usage.billableCostUsd ?? usage.estimatedCostUsd);

      // By model
      const modelKey = `${usage.provider}:${usage.model}`;
      const modelEntry = byModel.get(modelKey) ?? {
        provider: usage.provider,
        model: usage.model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalLatencyMs: 0,
        totalCostUsd: 0,
        callCount: 0,
      };
      modelEntry.totalInputTokens += usage.inputTokens;
      modelEntry.totalOutputTokens += usage.outputTokens;
      modelEntry.totalLatencyMs += usage.latencyMs;
      modelEntry.totalCostUsd += costUsd;
      modelEntry.callCount += 1;
      byModel.set(modelKey, modelEntry);

      // By agent
      const agentKey = usage.agentRun?.agentKey ?? "unknown";
      const agentEntry = byAgent.get(agentKey) ?? {
        agentKey,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
      };
      agentEntry.totalInputTokens += usage.inputTokens;
      agentEntry.totalOutputTokens += usage.outputTokens;
      agentEntry.totalCostUsd += costUsd;
      agentEntry.callCount += 1;
      byAgent.set(agentKey, agentEntry);

      // By day
      const dateKey = usage.createdAt.toISOString().slice(0, 10);
      const dayEntry = byDay.get(dateKey) ?? {
        date: dateKey,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
      };
      dayEntry.totalInputTokens += usage.inputTokens;
      dayEntry.totalOutputTokens += usage.outputTokens;
      dayEntry.totalCostUsd += costUsd;
      dayEntry.callCount += 1;
      byDay.set(dateKey, dayEntry);
    }
    if (candidates.length < 100) break;
    afterId = candidates[candidates.length - 1].id;
  }

  const totalCostUsd = [...byModel.values()].reduce((sum, m) => sum + m.totalCostUsd, 0);
  const totalTokens = [...byModel.values()].reduce((sum, m) => sum + m.totalInputTokens + m.totalOutputTokens, 0);

  return withArtifactCountReleaseSnapshot(actor, workspaceId, [...roots.values()], async () => undefined, async tx => {
    const current = await requireWorkspaceMembership({actor, workspaceId, tx});
    invariant(actor.kind === "user" && current?.role === "ADMIN", 403, "FORBIDDEN", "Model usage costs require a current workspace administrator.");
    return {
      periodDays,
      totalCostUsd,
      totalTokens,
      totalCalls,
      byModel: [...byModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      byAgent: [...byAgent.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}

function parseCost(value: unknown): number {
  if (value == null) return 0;
  const num = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(num) ? num : 0;
}
