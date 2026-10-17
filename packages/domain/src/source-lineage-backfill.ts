import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import {
  captureArtifactInputProof,
  inspectStoredArtifactInputDependencies,
  invalidateArtifactInputLineage,
  isArtifactInputProofReadable,
  lineageContentFingerprint,
  recordArtifactInputLineage,
  type LineageInput,
  type LineageKind,
  type LineageRoot,
} from "./source-lineage";
import { planSourceLineageRebuild } from "./source-lineage-rebuild";

type Db = Prisma.TransactionClient | typeof prisma;
type Row = Record<string, unknown> & { id: string };
type Delegate = { findFirst(args: Record<string, unknown>): Promise<Row | null>; findMany(args: Record<string, unknown>): Promise<Row[]> };
type Descriptor = { delegate: string; table: string; scope(workspaceId: string): Record<string, unknown>; select?: Record<string, boolean>; include?: Record<string, unknown> };
const direct = (kind: string, delegate: string): Descriptor => ({ delegate, table: kind, scope: (workspaceId) => ({ workspaceId }) });
const child = (kind: string, delegate: string, relation: string): Descriptor => ({ delegate, table: kind, scope: (workspaceId) => ({ [relation]: { workspaceId } }) });

/** Explicit inventory scope. New kinds require a reviewed loader instead of an unscoped generic table scan. */
const LOADERS: Record<Exclude<LineageKind, "ExternalMcpConnectionSet">, Descriptor> = {
  ExternalDataSource: direct("ExternalDataSource", "externalDataSource"),
  SqlNativeRunInput: direct("SqlNativeRunInput", "sqlNativeRunInput"),
  OAuthProviderFetchInput: direct("OAuthProviderFetchInput", "oAuthProviderFetchInput"),
  MeetingAudioAsset: direct("MeetingAudioAsset", "meetingAudioAsset"),
  NativeTranscriptInput: direct("NativeTranscriptInput", "nativeTranscriptInput"),
  CommunicationMessageNativeInput: direct("CommunicationMessageNativeInput", "communicationMessageNativeInput"),
  GenericDerivedArtifactVariant: direct("GenericDerivedArtifactVariant", "genericDerivedArtifactVariant"),
  ExternalProviderFetchInput: direct("ExternalProviderFetchInput", "externalProviderFetchInput"), ExternalContentSource: direct("ExternalContentSource", "externalContentSource"),
  ExternalMcpResponseInput: direct("ExternalMcpResponseInput", "externalMcpResponseInput"),
  FinanceReport: direct("FinanceReport", "financeReport"),
  FinanceReportFactRevision: direct("FinanceReportFactRevision", "financeReportFactRevision"),
  FinanceReportFact: direct("FinanceReportFact", "financeReportFact"),
  FinanceImportApplication: direct("FinanceImportApplication", "financeImportApplication"),

  FinanceImportBatch: direct("FinanceImportBatch", "financeImportBatch"), FinanceImportCandidate: direct("FinanceImportCandidate", "financeImportCandidate"),
  FinanceReportUploadInput: direct("FinanceReportUploadInput", "financeReportUploadInput"),
  CrmQualificationFormInput: direct("CrmQualificationFormInput", "crmQualificationFormInput"),
  ExecutionRequest: direct("ExecutionRequest", "executionRequest"), ExecutionResult: direct("ExecutionResult", "executionResult"),
  ConversationOperationOutcome: direct("ConversationOperationOutcome", "conversationOperationOutcome"),
  WorkspaceToolLink: { ...direct("WorkspaceToolLink", "workspaceToolLink"), include: { circleTags: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } },
  WorkspaceToolLinkCredential: direct("WorkspaceToolLink", "workspaceToolLink"),
  McpToolInput: direct("McpToolInput", "mcpToolInput"),
  ConversationIngressInput: direct("ConversationIngressInput", "conversationIngressInput"),
  DemoLeadIntakeInput: { ...direct("DemoLead", "demoLead"), select: { id: true, workspaceId: true, email: true, source: true, createdAt: true } },
  CrmQualificationEmailInput: { ...direct("CrmQualification", "crmQualification"), scope: (workspaceId) => ({ workspaceId, responseChannel: "email_reply" }), select: { id: true, workspaceId: true, demoLeadId: true, responseChannel: true, rawEmailReply: true, rawEmailSubject: true, createdAt: true } },
  DemoLead: direct("DemoLead", "demoLead"), CrmQualification: direct("CrmQualification", "crmQualification"),
  WorkflowJobInput: { ...direct("WorkflowJob", "workflowJob"), select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true } },
  AgentRequestInput: direct("AgentRequestInput", "agentRequestInput"), AgentFeedbackInput: direct("AgentFeedbackInput", "agentFeedbackInput"),
  ConversationPendingOperation: direct("ConversationPendingOperation", "conversationPendingOperation"),
  BrainDiscussionThread: child("BrainDiscussionThread", "brainDiscussionThread", "article"),
  BrainDiscussionComment: { delegate: "brainDiscussionComment", table: "BrainDiscussionComment", scope: (workspaceId) => ({ thread: { article: { workspaceId } } }) },
  AgentRun: direct("AgentRun", "agentRun"), AgentStep: child("AgentStep", "agentStep", "agentRun"), AgentToolCall: child("AgentToolCall", "agentToolCall", "agentRun"),
  Workspace: { delegate: "workspace", table: "Workspace", scope: (workspaceId) => ({ id: workspaceId }), select: { id: true, name: true, slug: true, description: true, plan: true, createdAt: true, updatedAt: true } },
  User: { delegate: "user", table: "User", scope: (workspaceId) => ({ memberships: { some: { workspaceId, isActive: true } } }),
    select: { id: true, email: true, displayName: true, bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } },
  Member: { ...direct("Member", "member"), include: { user: { select: { id: true, email: true, displayName: true } } } },
  AgentIdentity: { ...direct("AgentIdentity", "agentIdentity"), select: { id: true, workspaceId: true, agentKey: true, memberType: true,
    displayName: true, purposeMd: true, behaviorMd: true, isActive: true, archivedAt: true, createdAt: true, updatedAt: true } },
  CircleAgentAssignment: { delegate: "circleAgentAssignment", table: "CircleAgentAssignment", scope: (workspaceId) => ({ circle: { workspaceId }, agentIdentity: { workspaceId } }) },
  Role: child("Role", "role", "circle"), Circle: direct("Circle", "circle"),
  RoleAssignment: { delegate: "roleAssignment", table: "RoleAssignment", scope: (workspaceId) => ({ member: { workspaceId }, role: { circle: { workspaceId } } }) },
  RoleVersion: direct("RoleVersion", "roleVersion"), RoleHolderHistory: direct("RoleHolderHistory", "roleHolderHistory"),
  BrainSource: direct("BrainSource", "brainSource"), BrainArticle: direct("BrainArticle", "brainArticle"), BrainArticleVersion: child("BrainArticleVersion", "brainArticleVersion", "article"),
  Document: direct("Document", "document"), Meeting: direct("Meeting", "meeting"),
  MeetingTranscript: { ...direct("Meeting", "meeting"), select: { id: true, workspaceId: true, title: true, source: true, transcript: true,
    ingestionGuidanceMd: true, recordedAt: true, scheduledEndAt: true, seriesId: true, participantIds: true, participantEmails: true, archivedAt: true, createdAt: true } },
  MeetingAgenda: { ...direct("Meeting", "meeting"), select: { id: true, workspaceId: true, agendaJson: true, archivedAt: true, createdAt: true } },
  MeetingInsight: direct("MeetingInsight", "meetingInsight"), MeetingSeries: direct("MeetingSeries", "meetingSeries"), MeetingFollowUpReview: direct("MeetingFollowUpReview", "meetingFollowUpReview"),
  DeliberationEntry: direct("DeliberationEntry", "deliberationEntry"), KnowledgeChunk: direct("KnowledgeChunk", "knowledgeChunk"),
  Action: direct("Action", "action"), ActionChecklistItem: direct("ActionChecklistItem", "actionChecklistItem"), Tension: direct("Tension", "tension"), TensionUpvote: child("TensionUpvote", "tensionUpvote", "tension"),
  Recognition: direct("Recognition", "recognition"), GoalUpdate: child("GoalUpdate", "goalUpdate", "goal"), KeyResult: child("KeyResult", "keyResult", "goal"),
  CommunicationExternalUser: direct("CommunicationExternalUser", "communicationExternalUser"), CommunicationEntityLink: direct("CommunicationEntityLink", "communicationEntityLink"),
  CommunicationChannel: direct("CommunicationChannel", "communicationChannel"), CommunicationMessage: direct("CommunicationMessage", "communicationMessage"), CommunicationContextSummary: direct("CommunicationContextSummary", "communicationContextSummary"),
  BuildArtifact: direct("BuildArtifact", "buildArtifact"), BuildArtifactAsset: child("BuildArtifactAsset", "buildArtifactAsset", "artifact"),
  AgentMemory: direct("AgentMemory", "agentMemory"), ConversationPromptInput: direct("ConversationPromptInput", "conversationPromptInput"),
  AdviceRequest: direct("AdviceRequest", "adviceRequest"), ConversationSession: direct("ConversationSession", "conversationSession"), ConversationTurn: child("ConversationTurn", "conversationTurn", "conversation"),
  RoleOnboardingSession: direct("RoleOnboardingSession", "roleOnboardingSession"), PolicyCorpus: direct("PolicyCorpus", "policyCorpus"), Notification: direct("Notification", "notification"),
  CrmAccount: direct("CrmAccount", "crmAccount"), CrmContact: direct("CrmContact", "crmContact"), CrmDeal: direct("CrmDeal", "crmDeal"), CrmActivity: direct("CrmActivity", "crmActivity"),
  CrmDealStageTransition: direct("CrmDealStageTransition", "crmDealStageTransition"), CrmConversation: direct("CrmConversation", "crmConversation"), CrmConversationMessage: child("CrmConversationMessage", "crmConversationMessage", "conversation"),
  CrmProspectWorkspace: { delegate: "crmProspectWorkspace", table: "CrmProspectWorkspace", scope: (workspaceId) => ({ crmWorkspaceId: workspaceId }) },
  CrmCommunicationSuggestion: direct("CrmCommunicationSuggestion", "crmCommunicationSuggestion"),
  ModelUsageBudget: direct("ModelUsageBudget", "modelUsageBudget"), ModelUsageCost: { ...direct("ModelUsage", "modelUsage"), select: { id: true, workspaceId: true, estimatedCostUsd: true, billableCostUsd: true, createdAt: true } },
  ApprovalPolicy: direct("ApprovalPolicy", "approvalPolicy"), ApprovalFlow: direct("ApprovalFlow", "approvalFlow"), ApprovalDecision: child("ApprovalDecision", "approvalDecision", "flow"), Objection: child("Objection", "objection", "flow"),
  Constitution: direct("Constitution", "constitution"), ConstitutionSourceReference: direct("ConstitutionSourceReference", "constitutionSourceReference"),
  Proposal: direct("Proposal", "proposal"), Goal: direct("Goal", "goal"), GoalLink: child("GoalLink", "goalLink", "goal"), CheckIn: direct("CheckIn", "checkIn"),
  ContextGraphObject: direct("ContextGraphObject", "contextGraphObject"), ContextGraphRelationship: direct("ContextGraphRelationship", "contextGraphRelationship"), ContextGraphEvidenceRef: direct("ContextGraphEvidenceRef", "contextGraphEvidenceRef"), ContextGraphProposedDiff: direct("ContextGraphProposedDiff", "contextGraphProposedDiff"),
  ContextMapView: direct("ContextMapView", "contextMapView"), ContextMapLayoutItem: child("ContextMapLayoutItem", "contextMapLayoutItem", "mapView"),
  WorkspaceBriefing: direct("WorkspaceBriefing", "workspaceBriefing"), NewspaperEdition: direct("NewspaperEdition", "newspaperEdition"), NewspaperTrackedLink: direct("NewspaperTrackedLink", "newspaperTrackedLink"), NewspaperDelivery: direct("NewspaperDelivery", "newspaperDelivery"),
  ArtifactInputSnapshot: direct("ArtifactInputSnapshot", "artifactInputSnapshot"),
};

const NATIVE_INPUTS = new Set<LineageKind>(["OAuthProviderFetchInput", "NativeTranscriptInput", "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet", "FinanceReportUploadInput", "CrmQualificationFormInput", "McpToolInput", "Workspace", "Member", "User", "RoleAssignment", "CircleAgentAssignment",
  "ConversationIngressInput", "DemoLeadIntakeInput", "CrmQualificationEmailInput", "CommunicationChannel", "ConversationPromptInput", "AgentRequestInput", "AgentFeedbackInput", "ModelUsageBudget", "ModelUsageCost", "ApprovalPolicy", "CrmDealStageTransition",
  "TensionUpvote", "ArtifactInputSnapshot"]);
export const SOURCE_LINEAGE_BACKFILL_KINDS = (Object.keys(LOADERS) as LineageKind[]).filter((kind) => !NATIVE_INPUTS.has(kind));
const GENERATED_ONLY = new Set<LineageKind>(["MeetingAudioAsset", "GenericDerivedArtifactVariant", "CommunicationMessage", "AgentMemory", "ConversationTurn", "CommunicationContextSummary", "WorkspaceBriefing",
  "FinanceReport", "FinanceReportFact", "FinanceReportFactRevision", "FinanceImportApplication", "FinanceImportBatch", "FinanceImportCandidate",
  "NewspaperEdition", "NewspaperDelivery", "NewspaperTrackedLink", "Notification", "AgentRun", "AgentStep", "AgentToolCall", "ConversationPendingOperation", "ConversationOperationOutcome", "ExecutionResult", "KnowledgeChunk"]);

export type SourceLineageBackfillStatus = "VERIFIED_CURRENT" | "RECOVERABLE_SNAPSHOT" | "WITHHELD" | "MISSING" | "UNSUPPORTED";
export type SourceLineageBackfillEntry = LineageInput & {
  status: SourceLineageBackfillStatus;
  reason: string;
  contentHash?: string;
  snapshotId?: string;
  origin?: "HUMAN_ORIGINAL" | "DERIVED";
  recipeTypes: string[];
  blockers: string[];
};
type Inspected = { entry: SourceLineageBackfillEntry; row?: Row; roots?: LineageRoot[]; latest?: { revision: number; origin: string; contentHash: string } | null };

function descriptor(kind: LineageKind) { return Object.hasOwn(LOADERS, kind) ? LOADERS[kind as keyof typeof LOADERS] : undefined; }
function delegate(db: Db, info: Descriptor) { return (db as unknown as Record<string, Delegate>)[info.delegate]!; }
function rowQuery(info: Descriptor, workspaceId: string, id?: string) {
  return { where: { AND: [info.scope(workspaceId), ...(id === undefined ? [] : [{ id }])] }, ...(info.select ? { select: info.select } : {}), ...(info.include ? { include: info.include } : {}) };
}
function unproven(error: unknown) { return error instanceof AppError && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function recipeTypes(kind: LineageKind, row: Row) {
  if (kind === "WorkspaceBriefing" || kind === "NewspaperEdition") return ["brain.daily-digest"];
  if (kind === "CheckIn" && row.questionSource === "company-understanding") return ["agent.company-understanding"];
  if (kind === "ContextGraphProposedDiff" && typeof row.reason === "string" && row.reason.startsWith("Company understanding proposal: ")) return ["agent.company-understanding"];
  if (["ContextGraphObject", "ContextGraphRelationship"].includes(kind)
    && typeof row.sourceEntityId === "string" && ["Member", "Goal", "AgentIdentity", "BrainArticle", "Proposal", "Action", "Tension", "Circle", "Role", "Document", "Meeting", "MeetingInsight"].includes(String(row.sourceEntityType))) {
    return ["context-graph.reconcile"];
  }
  return [];
}

async function inspect(db: Db, actor: AppActor, workspaceId: string, input: LineageInput, snapshotScanLimit = 1_000): Promise<Inspected> {
  const info = descriptor(input.kind);
  const entry: SourceLineageBackfillEntry = { ...input, status: "UNSUPPORTED", reason: "NO_SCOPED_LOADER", recipeTypes: [], blockers: ["NO_SCOPED_LOADER"] };
  if (!info) return { entry };
  const row = await delegate(db, info).findFirst(rowQuery(info, workspaceId, input.id));
  if (!row) return { entry: { ...entry, status: "MISSING", reason: "ARTIFACT_UNAVAILABLE", blockers: [] } };
  const hash = lineageContentFingerprint(input.kind, row);
  const latest = await db.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: input.kind, artifactId: input.id }, orderBy: { revision: "desc" } });
  const types = recipeTypes(input.kind, row);
  const withheld: SourceLineageBackfillEntry = { ...entry, status: "WITHHELD", contentHash: hash, reason: "NO_COMPLETE_HISTORICAL_EVIDENCE", recipeTypes: types,
    blockers: types.length ? ["ORIGINAL_REMAINS_WITHHELD_UNTIL_FRESH_OUTPUT"] : ["NO_SAFE_AUTOMATIC_REBUILD_RECIPE"] };
  // An explicit latest UNKNOWN/stale receipt must never be overwritten from old evidence.
  if (latest && (latest.origin === "UNKNOWN" || latest.contentHash !== hash)) {
    return { row, latest, entry: { ...withheld, reason: latest.origin === "UNKNOWN" ? "LATEST_UNKNOWN_RECEIPT" : "UNRECEIPTED_CONTENT_CHANGE" } };
  }
  try {
    await captureArtifactInputProof(actor, workspaceId, [{ ...input, snapshot: row }], db);
    return { row, latest, entry: { ...withheld, status: "VERIFIED_CURRENT", reason: "CURRENT_PROOF_VALID", recipeTypes: [], blockers: [] } };
  } catch (error) { if (!unproven(error)) throw error; }
  if (latest) return { row, latest, entry: { ...withheld, reason: "CURRENT_RECEIPT_RESTRICTED_OR_INCOMPLETE" } };
  // Neither citations nor audit actors identify the complete historical input set.
  // Only an already recorded immutable proof of this exact full content can recover a missing receipt.
  const evidenceScope = { workspaceId, sourceKind: input.kind, sourceId: input.id, sourceFingerprint: hash };
  let after: { createdAt: Date; id: string } | undefined;
  const boundary = () => after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {};
  for (let scanned = 0; scanned < snapshotScanLimit;) {
    const take = Math.min(100, snapshotScanLimit - scanned);
    const snapshots = await db.artifactInputSnapshot.findMany({ where: { ...evidenceScope, ...boundary() },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
    for (const snapshot of snapshots) {
      if (!record(snapshot.contentJson) || lineageContentFingerprint(input.kind, snapshot.contentJson) !== hash
        || !Array.isArray(snapshot.rootsJson) || !["HUMAN_ORIGINAL", "DERIVED"].includes(snapshot.origin)
        || (snapshot.origin === "HUMAN_ORIGINAL" && snapshot.rootsJson.length !== 0)
        || (snapshot.origin === "DERIVED" && snapshot.rootsJson.length === 0)) continue;
      if (snapshot.origin === "HUMAN_ORIGINAL" && (actor.kind !== "user" || GENERATED_ONLY.has(input.kind))) continue;
      try {
        const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ArtifactInputSnapshot", id: snapshot.id, snapshot }], db);
        const closure = await inspectStoredArtifactInputDependencies(db, workspaceId, roots);
        if (!closure.complete || !await isArtifactInputProofReadable(actor, workspaceId, roots, db)) continue;
        return { row, latest, roots, entry: { ...withheld, status: "RECOVERABLE_SNAPSHOT", reason: "EXACT_RECORDED_CONTENT_AND_INPUTS", snapshotId: snapshot.id,
          origin: snapshot.origin as "HUMAN_ORIGINAL" | "DERIVED", recipeTypes: [], blockers: [] } };
      } catch (error) { if (!unproven(error)) throw error; }
    }
    if (snapshots.length < take) return { row, latest, entry: withheld };
    scanned += snapshots.length;
    after = snapshots.at(-1);
  }
  const more = await db.artifactInputSnapshot.findMany({ where: { ...evidenceScope, ...boundary() }, select: { id: true }, take: 1 });
  return { row, latest, entry: more.length ? { ...withheld, reason: "SNAPSHOT_EVIDENCE_SCAN_LIMIT", blockers: [...withheld.blockers, "SNAPSHOT_EVIDENCE_SCAN_LIMIT"] } : withheld };
}

async function requireBackfillOperator(actor: AppActor, workspaceId: string, db: Db) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db });
  invariant(actor.kind === "agent" || membership?.role === "ADMIN", 403, "ADMIN_REQUIRED", "Lineage backfill requires an authorized workspace operator.");
}

type BackfillSelection = { actor: AppActor; workspaceId: string; artifacts?: LineageInput[]; kinds?: LineageKind[]; scanLimit?: number; snapshotScanLimit?: number; asOf?: Date };

async function discover(db: Db, params: BackfillSelection) {
  invariant(!(params.artifacts && params.kinds), 400, "INVALID_INPUT", "Select artifact IDs or kinds.");
  const limit = params.scanLimit ?? 5_000;
  invariant(Number.isInteger(limit) && limit > 0 && limit <= 50_000, 400, "INVALID_INPUT", "Backfill scan limit is invalid.");
  invariant(params.snapshotScanLimit === undefined || (Number.isInteger(params.snapshotScanLimit) && params.snapshotScanLimit > 0 && params.snapshotScanLimit <= 50_000),
    400, "INVALID_INPUT", "Backfill evidence scan limit is invalid.");
  if (params.artifacts) {
    invariant(params.artifacts.every((input) => typeof input.id === "string" && input.id.trim().length > 0),
      400, "INVALID_INPUT", "Backfill artifact IDs are required.");
    const unique = [...new Map(params.artifacts.map((input) => [`${input.kind}:${input.id}`, input])).values()];
    invariant(unique.length <= limit, 503, "BACKFILL_SCAN_LIMIT", "Partition the backfill before applying it.");
    return unique;
  }
  const inputs: LineageInput[] = [];
  for (const kind of [...new Set(params.kinds ?? SOURCE_LINEAGE_BACKFILL_KINDS)]) {
    const info = descriptor(kind);
    if (!info) { inputs.push({ kind, id: "" }); continue; }
    let after: string | undefined;
    while (true) {
      const rows = await delegate(db, info).findMany({ where: { AND: [info.scope(params.workspaceId), ...(after ? [{ id: { gt: after } }] : [])] },
        select: { id: true }, orderBy: { id: "asc" }, take: 100 });
      inputs.push(...rows.map((row) => ({ kind, id: row.id })));
      invariant(inputs.length <= limit, 503, "BACKFILL_SCAN_LIMIT", "Partition the backfill before applying it.");
      if (rows.length < 100) break;
      after = rows.at(-1)!.id;
    }
  }
  return inputs;
}

function summary(entries: SourceLineageBackfillEntry[]) {
  return Object.fromEntries((["VERIFIED_CURRENT", "RECOVERABLE_SNAPSHOT", "WITHHELD", "MISSING", "UNSUPPORTED"] as const)
    .map((status) => [status, entries.filter((entry) => entry.status === status).length])) as Record<SourceLineageBackfillStatus, number>;
}

function rebuildPlan(workspaceId: string, entries: SourceLineageBackfillEntry[], asOf = new Date()) {
  const types = new Set(entries.flatMap((entry) => entry.recipeTypes));
  if (!types.size) return null;
  const identity = entries.filter((entry) => entry.recipeTypes.length).map((entry) => `${entry.kind}:${entry.id}:${entry.contentHash}`).sort();
  invariant(Number.isFinite(asOf.getTime()), 400, "INVALID_INPUT", "Backfill date is invalid.");
  const day = asOf.toISOString().slice(0, 10);
  const hash = createHash("sha256").update(JSON.stringify(["lineage-backfill-v1", workspaceId, identity, [...types].sort(), day])).digest("hex");
  const id = `lineage-backfill-${hash}`;
  const event = { id, workspaceId, type: "source-lineage.changed", createdAt: new Date(`${day}T00:00:00Z`) };
  return { event, recipes: planSourceLineageRebuild(event).filter((recipe) => types.has(recipe.type)) };
}

/** Internal migration inventory only: no original text, citations, labels or permission grants are returned. */
export async function inspectSourceLineageBackfill(params: BackfillSelection) {
  await requireBackfillOperator(params.actor, params.workspaceId, prisma);
  const inputs = await discover(prisma, params);
  const entries: SourceLineageBackfillEntry[] = [];
  for (const input of inputs) entries.push((await inspect(prisma, params.actor, params.workspaceId, input, params.snapshotScanLimit)).entry);
  return { workspaceId: params.workspaceId, entries, counts: summary(entries), rebuild: rebuildPlan(params.workspaceId, entries, params.asOf) };
}

/** Repeatable, default dry run. Applying changes only proof records and queues fresh recipes; it never rewrites or deletes originals.
 * This task executes it only against disposable synthetic databases. Production use requires a separately authorized rollout. */
export async function runSourceLineageBackfill(params: BackfillSelection & { mode?: "dry-run" | "apply"; scheduleRebuilds?: boolean }) {
  if (params.mode !== "apply") return { mode: "dry-run" as const, ...await inspectSourceLineageBackfill(params), certified: 0, markedUnknown: 0, scheduled: 0 };
  await requireBackfillOperator(params.actor, params.workspaceId, prisma);
  const inputs = await discover(prisma, params); // Complete inventory/limit gate before any mutation.
  return prisma.$transaction(async (tx) => {
    await requireBackfillOperator(params.actor, params.workspaceId, tx);
    const entries: SourceLineageBackfillEntry[] = [];
    let certified = 0;
    let markedUnknown = 0;
    for (const input of inputs) {
      const info = descriptor(input.kind);
      if (info && input.id) {
        // Registry table names are fixed; all caller values are bound parameters.
        await tx.$queryRawUnsafe(`SELECT id FROM "${info.table}" WHERE id = $1 FOR UPDATE`, input.id);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('source-lineage-backfill'), hashtext(${`${params.workspaceId}:${input.kind}:${input.id}`}))`;
      }
      const result = await inspect(tx, params.actor, params.workspaceId, input, params.snapshotScanLimit);
      entries.push(result.entry);
      if (result.entry.status === "RECOVERABLE_SNAPSHOT" && result.row && result.roots) {
        invariant(await isArtifactInputProofReadable(params.actor, params.workspaceId, result.roots, tx),
          409, "SOURCE_CHANGED", "Recorded backfill inputs changed before certification.");
        await recordArtifactInputLineage({ tx, actor: params.actor, workspaceId: params.workspaceId, artifact: input, content: result.row,
          origin: result.entry.origin!, inputs: [], inheritedRoots: result.entry.origin === "DERIVED" ? result.roots : [] });
        result.entry.status = "VERIFIED_CURRENT";
        result.entry.reason = "RECOVERED_EXACT_SNAPSHOT";
        certified += 1;
      } else if (result.entry.status === "WITHHELD" && result.entry.reason !== "SNAPSHOT_EVIDENCE_SCAN_LIMIT" && result.row && result.latest?.origin !== "UNKNOWN"
        && (!result.latest || result.latest.contentHash !== result.entry.contentHash)) {
        await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact: input, content: result.row });
        markedUnknown += 1;
      }
    }
    const rebuild = rebuildPlan(params.workspaceId, entries, params.asOf);
    let scheduled = 0;
    if (params.scheduleRebuilds !== false && rebuild) {
      const event = await tx.event.upsert({ where: { id: rebuild.event.id }, update: {}, create: {
        ...rebuild.event, aggregateType: "ArtifactInputLineage", status: "DISPATCHED", payload: { reason: "legacy-backfill", version: 1 },
      } });
      invariant(event.workspaceId === params.workspaceId && event.type === "source-lineage.changed", 409, "SOURCE_CHANGED", "Backfill event identity changed.");
      for (const recipe of rebuild.recipes) {
        const existing = await tx.workflowJob.findUnique({ where: { dedupeKey: recipe.dedupeKey }, select: { id: true } });
        await tx.workflowJob.upsert({ where: { dedupeKey: recipe.dedupeKey }, update: {}, create: recipe });
        if (!existing) scheduled += 1;
      }
    }
    return { mode: "apply" as const, workspaceId: params.workspaceId, entries, counts: summary(entries), rebuild, certified, markedUnknown, scheduled };
  }, { timeout: 60_000 });
}

/** Guard for a local disposable runner. This checks destination identity, never logs credentials or connects by itself. */
export function assertDisposableSourceLineageBackfillDatabaseUrl(databaseUrl: string) {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new AppError(400, "UNSAFE_BACKFILL_TARGET", "A local disposable database is required."); }
  const database = decodeURIComponent(url.pathname.slice(1));
  invariant(["postgres:", "postgresql:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && /^[a-zA-Z0-9_]+_test$/.test(database), 400, "UNSAFE_BACKFILL_TARGET", "A local disposable database is required.");
  return { hostname: url.hostname, port: url.port, database };
}
