import { createHash, randomUUID } from "node:crypto";
import { Prisma, type ConversationOperationOutcome } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { canReadInformationCategory } from "./information-category-policy";
import { appendEvents } from "./events";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, captureArtifactPermissionEpochs,
  isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage, sealArtifactInputActor,
  type LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent, type PermissionEpochProof } from "./source-permission-epochs";

export const BRAIN_EXPORT_CONSENT = "BRAIN_EXPORT_CONSENT";
export type BrainTranscriptMode = "NONE" | "PARTIAL" | "FULL";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const brainExportHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export type BrainExportRequest = { workspaceId: string; conversationId: string; outputTurnId: string; expectedOutputHash: string;
  title: string; transcriptMode: BrainTranscriptMode; selectedTurns: Array<{ id: string; hash: string }>; requestId: string };
export type BrainExportPrivateInput = { kind: "ConversationPromptInput" | "ConversationSession" | "ConversationTurn"; id: string; fingerprint: string };
type Capsule = { version: 1; requestHash?: string; receiptId: string; workspaceId: string; userId: string; conversationId: string;
  sourceId: string; sourceHash: string; outputTurnId: string; outputHash: string; transcriptMode: BrainTranscriptMode;
  selectedTurns: Array<{ id: string; hash: string }>; roots: LineageRoot[]; privateInputs: BrainExportPrivateInput[]; epochs: PermissionEpochProof };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function brainExportSourceHash(row: { id: string; workspaceId: string; title: string | null; content: string; metadata: unknown }) {
  return brainExportHash([row.id, row.workspaceId, row.title, row.content, row.metadata]);
}
/** Authenticated capsule parsing is structural discovery, never a serving grant. */
export function decodeBrainExportConsent(row: Record<string, unknown>): Capsule | null {
  try {
    if (row.operation !== BRAIN_EXPORT_CONSENT || row.actorKind !== "user" || typeof row.userId !== "string"
      || row.credentialId != null || row.credentialVersion != null || row.scopeHash != null
      || !Array.isArray(row.requiredScopes) || row.requiredScopes.length || !isRecord(row.controlJson)
      || row.controlJson.version !== 1 || typeof row.controlJson.ciphertext !== "string") return null;
    const capsule = JSON.parse(decryptSecret(row.controlJson.ciphertext)) as Capsule;
    if (capsule.version !== 1 || capsule.receiptId !== row.id || capsule.workspaceId !== row.workspaceId || capsule.userId !== row.userId
      || !capsule.sourceId || !capsule.conversationId || !capsule.outputTurnId || !["NONE", "PARTIAL", "FULL"].includes(capsule.transcriptMode)
      || !Array.isArray(capsule.roots) || !capsule.roots.length || capsule.roots.length > 10000
      || capsule.roots.some(root => root.kind !== "ArtifactInputSnapshot" || typeof root.id !== "string" || !/^[a-f0-9]{64}$/.test(root.fingerprint))
      || !Array.isArray(capsule.privateInputs) || capsule.privateInputs.length > 10000
      || capsule.privateInputs.some(input => !["ConversationPromptInput", "ConversationSession", "ConversationTurn"].includes(input.kind)
        || typeof input.id !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint))) return null;
    return capsule;
  } catch { return null; }
}
export async function currentBrainExportConsent(actor: AppActor, row: Record<string, unknown>, workspaceId: string, db: Prisma.TransactionClient) {
  const capsule = decodeBrainExportConsent(row);
  if (!capsule || capsule.workspaceId !== workspaceId || !await isArtifactPermissionEpochProofCurrent(workspaceId, capsule.epochs, db)) return null;
  const source = await db.brainSource.findFirst({ where: { id: capsule.sourceId, workspaceId, archivedAt: null } });
  const session = await db.conversationSession.findFirst({ where: { id: capsule.conversationId, workspaceId, userId: capsule.userId } });
  const owner = await db.member.findFirst({ where: { workspaceId, userId: capsule.userId, isActive: true } });
  return source && session && owner && brainExportSourceHash(source) === capsule.sourceHash
    && await canReadInformationCategory(actor, workspaceId, source.informationCategory, db) ? capsule : null;
}

/** The authenticated human selects an exact persisted output. Model arguments,
 * copied receipts and client-supplied answer text cannot issue this authority. */
export async function exportConversationAnswerToBrain(actor: AppActor, submission: BrainExportRequest) {
  sealArtifactInputActor(actor);
  invariant(actor.kind === "user", 403, "BRAIN_CONSENT_REQUIRED", "Choose what to share from your conversation.");
  const request = structuredClone(submission), userId = actor.user.id;
  invariant(["NONE", "PARTIAL", "FULL"].includes(request.transcriptMode) && Array.isArray(request.selectedTurns)
    && request.selectedTurns.length <= 100 && request.selectedTurns.every(turn => turn && typeof turn.id === "string" && /^[a-f0-9]{64}$/.test(turn.hash))
    && new Set(request.selectedTurns.map(turn => turn.id)).size === request.selectedTurns.length
    && typeof request.requestId === "string" && /^[a-f0-9-]{16,64}$/i.test(request.requestId) && typeof request.title === "string" && request.title.trim().length > 0 && request.title.length <= 200,
  400, "INVALID_INPUT", "Choose an answer, a title and the transcript to include.");
  invariant(request.transcriptMode === "NONE" ? request.selectedTurns.length === 0 : request.selectedTurns.length > 0,
    400, "INVALID_INPUT", "The transcript selection does not match the sharing option.");
  const requestKey = brainExportHash([request.workspaceId, userId, BRAIN_EXPORT_CONSENT, request.requestId]);
  const requestHash = brainExportHash({...request, title: request.title.trim()});
  const persist = () => prisma.$transaction(async tx => {
    // Serialize one actor's exact request identity. A Serializable waiter may
    // need a fresh transaction snapshot before it can see the winning receipt.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}, 0))`;
    const membership = await requireWorkspaceMembership({ actor, workspaceId: request.workspaceId, tx });
    invariant(membership, 403, "FORBIDDEN", "A current member must confirm sharing.");
    const existing = await tx.conversationOperationOutcome.findUnique({where: {
      workspaceId_requestKey: {workspaceId: request.workspaceId, requestKey}}});
    if (existing) {
      const capsule = decodeBrainExportConsent(existing);
      const source = capsule && await tx.brainSource.findFirst({where: {id: capsule.sourceId, workspaceId: request.workspaceId}});
      invariant(capsule && capsule.userId === userId && source, 409, "BRAIN_EXPORT_CONFLICT", "This sharing request cannot be reused.");
      // Older receipts predate requestHash; their sealed source and capsule
      // retain every effective field of the original explicit sharing choice.
      const originalHash = capsule.requestHash ?? brainExportHash({
        ...request, workspaceId: capsule.workspaceId, conversationId: capsule.conversationId,
        outputTurnId: capsule.outputTurnId, expectedOutputHash: capsule.outputHash, title: source.title,
        transcriptMode: capsule.transcriptMode, selectedTurns: capsule.selectedTurns,
      });
      invariant(originalHash === requestHash, 409, "BRAIN_EXPORT_CONFLICT", "This request ID already belongs to a different sharing choice.");
      const root: LineageRoot = {kind: "ConversationOperationOutcome", id: existing.id,
        fingerprint: lineageContentFingerprint("ConversationOperationOutcome", existing)};
      invariant(await currentBrainExportConsent(actor, existing, request.workspaceId, tx)
        && await isArtifactInputProofReadable(actor, request.workspaceId, [root], tx),
      409, "SOURCE_CHANGED", "The original shared answer is no longer available with these permissions.");
      return {sourceId: capsule.sourceId, receiptId: existing.id};
    }
    await tx.$queryRaw`SELECT id FROM "ConversationSession" WHERE id=${request.conversationId}
      AND "workspaceId"=${request.workspaceId} AND "userId"=${userId} FOR SHARE`;
    const session = await tx.conversationSession.findFirst({ where: { id: request.conversationId, workspaceId: request.workspaceId, userId } });
    invariant(session, 404, "NOT_FOUND", "Conversation not found.");
    // NONE and PARTIAL bind only the chosen output and explicit metadata. FULL
    // still scans one sentinel beyond its complete-transcript limit.
    const turns = await tx.conversationTurn.findMany({ where: { conversationId: session.id,
      ...(request.transcriptMode === "FULL" ? {} : {id: {in: [request.outputTurnId, ...request.selectedTurns.map(turn => turn.id)]}}) },
      orderBy: [{ sequenceNumber: "asc" }, { id: "asc" }], take: 101 });
    invariant(request.transcriptMode !== "FULL" || turns.length <= 100, 413, "BRAIN_EXPORT_LIMIT", "Full transcript sharing supports at most 100 turns. Choose no transcript or a smaller selection.");
    const output = turns.find(turn => turn.id === request.outputTurnId);
    invariant(output && output.assistantMessage && brainExportHash(output.assistantMessage) === request.expectedOutputHash,
      409, "BRAIN_EXPORT_STALE", "The answer changed. Reload it before sharing.");
    const selected = turns.filter(turn => request.selectedTurns.some(choice => choice.id === turn.id));
    invariant(selected.length === request.selectedTurns.length && selected.every(turn => request.selectedTurns.some(choice => choice.id === turn.id
      && choice.hash === brainExportHash([turn.id, turn.userMessage, turn.assistantMessage])))
      && (request.transcriptMode !== "FULL" || selected.length === turns.length),
    409, "BRAIN_EXPORT_STALE", "The selected transcript changed. Reload it before sharing.");
    const consumed = [...new Map([output, ...selected].map(turn => [turn.id, turn])).values()];
    const roots = await captureImmutableArtifactInputProof(actor, request.workspaceId,
      await captureArtifactInputProof(actor, request.workspaceId, consumed.map(turn => ({ kind: "ConversationTurn" as const, id: turn.id, snapshot: turn })), tx), tx);
    invariant(roots.every(root => root.kind === "ArtifactInputSnapshot"), 409, "UNKNOWN_LINEAGE", "Complete preserved answer history is required.");
    const privateInputs: BrainExportPrivateInput[] = [];
    const snapshots = await tx.artifactInputSnapshot.findMany({ where: { workspaceId: request.workspaceId, id: { in: roots.map(root => root.id) } } });
    for (const snapshot of snapshots) {
      const content = snapshot.contentJson as Record<string, unknown>;
      if (snapshot.sourceKind === "ConversationPromptInput" && content.sessionId === session.id && content.userId === userId
        || snapshot.sourceKind === "ConversationSession" && snapshot.sourceId === session.id && content.userId === userId
        || snapshot.sourceKind === "ConversationTurn" && content.conversationId === session.id) {
        privateInputs.push({ kind: snapshot.sourceKind as BrainExportPrivateInput["kind"], id: snapshot.sourceId, fingerprint: snapshot.sourceFingerprint });
      }
    }
    const receiptId = randomUUID();
    const metadata = { version: 1, brainExportReceiptId: receiptId, transcriptMode: request.transcriptMode,
      transcript: selected.map(turn => ({ turnId: turn.id, userMessage: turn.userMessage, assistantMessage: turn.assistantMessage })) };
    invariant(Buffer.byteLength(JSON.stringify([output.assistantMessage, metadata])) <= 1_048_576,
      413, "BRAIN_EXPORT_LIMIT", "Choose less transcript text to share.");
    const source = await tx.brainSource.create({ data: { workspaceId: request.workspaceId, sourceType: "CONVERSATION", tier: 2,
      content: output.assistantMessage, title: request.title.trim(), metadata, authorMemberId: membership.id, channel: "chat-consent" } });
    const sourceRoot: LineageRoot = { kind: "BrainSource", id: source.id, fingerprint: lineageContentFingerprint("BrainSource", source) };
    const epochs = await captureArtifactPermissionEpochs(actor, request.workspaceId, [...roots, sourceRoot], tx);
    const capsule: Capsule = { version: 1, requestHash, receiptId, workspaceId: request.workspaceId, userId, conversationId: session.id,
      sourceId: source.id, sourceHash: brainExportSourceHash(source), outputTurnId: output.id, outputHash: request.expectedOutputHash,
      transcriptMode: request.transcriptMode, selectedTurns: request.selectedTurns, roots, privateInputs, epochs };
    const outcome: ConversationOperationOutcome = await tx.conversationOperationOutcome.create({ data: {
      id: receiptId, workspaceId: request.workspaceId, actorKind: "user", userId, operation: BRAIN_EXPORT_CONSENT,
      requestKey, requiredScopes: [],
      controlJson: { version: 1, ciphertext: encryptSecret(JSON.stringify(capsule)) } } });
    const root: LineageRoot = { kind: "ConversationOperationOutcome", id: receiptId, fingerprint: lineageContentFingerprint("ConversationOperationOutcome", outcome) };
    const receiptEpochs = await captureArtifactPermissionEpochs(actor, request.workspaceId, [root, ...roots, sourceRoot], tx);
    await tx.artifactInputLineage.create({ data: { workspaceId: request.workspaceId, artifactType: root.kind, artifactId: root.id,
      revision: 1, origin: "NATIVE_ORIGINAL", contentHash: root.fingerprint, inputsJson: [], rootsJson: [], epochProofVersion: 1,
      permissionEpochsJson: receiptEpochs as unknown as Prisma.InputJsonValue } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: request.workspaceId, artifact: { kind: "BrainSource", id: source.id },
      content: source, origin: "DERIVED", inputs: [], inheritedRoots: [{ ...root, permissionEpochs: receiptEpochs }] });
    await tx.auditLog.create({ data: { workspaceId: request.workspaceId, actorUserId: userId, action: "brain-source.created",
      entityType: "BrainSource", entityId: source.id, meta: { consentReceiptId: receiptId, transcriptMode: request.transcriptMode } } });
    await appendEvents(tx, [{ workspaceId: request.workspaceId, type: "brain-source.created", aggregateType: "BrainSource",
      aggregateId: source.id, payload: { sourceId: source.id } }]);
    invariant(await isArtifactInputProofReadable(actor, request.workspaceId, [root], tx), 409, "SOURCE_CHANGED", "Answer permissions changed before sharing.");
    return { sourceId: source.id, receiptId };
  }, { isolationLevel: "Serializable", timeout: 120_000, maxWait: 10_000 });
  for (let attempt = 0; ; attempt++) {
    try { return await persist(); } catch (error) {
      const uniqueRequestRace = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
        && Array.isArray(error.meta?.target) && error.meta.target.length === 2
        && error.meta.target.includes("workspaceId") && error.meta.target.includes("requestKey");
      const serializationRace = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === "P2034" || error.code === "P2010" && error.meta?.code === "40001");
      if (attempt >= 2 || !uniqueRequestRace && !serializationRace) throw error;
    }
  }
}
