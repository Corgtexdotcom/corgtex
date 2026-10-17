import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, type LineageInput, type LineageRoot } from "@corgtex/domain";

export function notificationProducerActor(workspaceId: string): AppActor {
  return { kind: "agent", authProvider: "bootstrap", label: "notification-event-producer", workspaceIds: [workspaceId] };
}

export async function captureNotificationEventRoots(tx: Prisma.TransactionClient, workspaceId: string,
  inputs: Array<LineageInput & { snapshot: Record<string, unknown> }>): Promise<LineageRoot[] | null> {
  try {
    return await captureArtifactInputProof(notificationProducerActor(workspaceId), workspaceId, inputs, tx);
  } catch (error) {
    if (error instanceof Error && "code" in error && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED", "NOT_FOUND"].includes(String(error.code))) return null;
    throw error;
  }
}

export type AdviceNotificationCapture = {
  adviceRequestId: string;
  requestedByUserId: string;
  authorUserId: string | null;
  subjectType: "ACTION" | "TENSION" | "PROPOSAL";
  subjectId: string;
  subjectTitle: string;
  messageMd: string;
  deadlineAt: string | null;
  lineageActor: AppActor;
  lineageRoots: LineageRoot[];
};

export async function captureCurrentAdviceNotification(tx: Prisma.TransactionClient, event: {
  type: string; workspaceId: string | null; aggregateType: string | null; aggregateId: string | null; payload: unknown;
}): Promise<AdviceNotificationCapture | null> {
  if (!event.workspaceId || !["advice.requested", "advice.reminder_due", "advice.reply_posted"].includes(event.type)) return null;
  const workspaceId = event.workspaceId;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
  const runtimeMeta = payload.runtimeMeta;
  if (runtimeMeta && typeof runtimeMeta === "object" && "replayOfEventId" in runtimeMeta
    && typeof runtimeMeta.replayOfEventId === "string" && runtimeMeta.replayOfEventId.trim()) return null;
  const requestId = typeof payload.adviceRequestId === "string" && payload.adviceRequestId.trim()
    ? payload.adviceRequestId.trim() : event.aggregateType === "AdviceRequest" ? event.aggregateId : null;
  if (!requestId) return null;
  await tx.$queryRaw`SELECT id FROM "AdviceRequest" WHERE id = ${requestId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const request = await tx.adviceRequest.findFirst({ where: { id: requestId, workspaceId } });
  if (!request || (event.type !== "advice.reply_posted" && request.status !== "ACTIVE") || request.status === "CANCELED") return null;
  await tx.$queryRaw`SELECT id FROM "AdviceProcess" WHERE id = ${request.processId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const process = await tx.adviceProcess.findFirst({ where: { id: request.processId, workspaceId } });
  if (!process) return null;
  const subjectId = process.subjectId;
  const where = { id: subjectId, workspaceId, archivedAt: null };
  let subject: { id: string; title: string; [key: string]: unknown } | null;
  let kind: "Action" | "Tension" | "Proposal";
  if (process.subjectType === "ACTION") {
    kind = "Action";
    await tx.$queryRaw`SELECT id FROM "Action" WHERE id = ${subjectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    subject = await tx.action.findFirst({ where });
  } else if (process.subjectType === "TENSION") {
    kind = "Tension";
    await tx.$queryRaw`SELECT id FROM "Tension" WHERE id = ${subjectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    subject = await tx.tension.findFirst({ where });
  } else if (process.subjectType === "PROPOSAL") {
    kind = "Proposal";
    await tx.$queryRaw`SELECT id FROM "Proposal" WHERE id = ${subjectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    subject = await tx.proposal.findFirst({ where });
  } else return null;
  if (!subject) return null;
  const subjectType = kind === "Action" ? "ACTION" : kind === "Tension" ? "TENSION" : "PROPOSAL";
  const inputs: Array<LineageInput & { snapshot: Record<string, unknown> }> = [
    { kind: "AdviceRequest", id: request.id, snapshot: request }, { kind, id: subject.id, snapshot: subject },
  ];
  let authorUserId: string | null = null;
  if (event.type === "advice.reply_posted") {
    const entryId = event.aggregateType === "DeliberationEntry" ? event.aggregateId : null;
    if (!entryId) return null;
    await tx.$queryRaw`SELECT id FROM "DeliberationEntry" WHERE id = ${entryId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const entry = await tx.deliberationEntry.findFirst({ where: {
      id: entryId, workspaceId, adviceRequestId: request.id, parentType: subjectType, parentId: subject.id,
    } });
    if (!entry) return null;
    authorUserId = entry.authorUserId;
    inputs.push({ kind: "DeliberationEntry", id: entry.id, snapshot: entry });
  }
  const lineageRoots = await captureNotificationEventRoots(tx, workspaceId, inputs);
  if (!lineageRoots) return null;
  return { adviceRequestId: request.id, requestedByUserId: request.requestedByUserId, authorUserId,
    subjectType, subjectId: subject.id,
    subjectTitle: subject.title, messageMd: request.messageMd, deadlineAt: request.deadlineAt?.toISOString() ?? null,
    lineageActor: notificationProducerActor(workspaceId), lineageRoots };
}
