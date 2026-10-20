import type { KnowledgeSourceType, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { lineageContentFingerprint, type LineageKind } from "../../domain/src/source-lineage";

export const canonicalKnowledgeKinds = {
  TENSION: "Tension", ACTION: "Action", CIRCLE: "Circle", ROLE: "Role", SLACK: "CommunicationMessage",
} as const satisfies Partial<Record<KnowledgeSourceType, LineageKind>>;

type SourceRecord = { id: string; [key: string]: unknown };
export type CanonicalKnowledgeSource = {
  kind: LineageKind;
  contentHash: string;
  content: string;
  rawContent: null;
  title: string;
  record: SourceRecord;
  inputs: Array<{ kind: LineageKind; id: string; snapshot: SourceRecord }>;
  metadata: Record<string, unknown>;
};
type Db = typeof prisma | Prisma.TransactionClient;

function source(kind: LineageKind, record: SourceRecord, title: string, content: string,
  joins: Array<[LineageKind, SourceRecord | null | undefined]>, metadata: Record<string, unknown> = {}): CanonicalKnowledgeSource {
  const inputs = new Map<string, CanonicalKnowledgeSource["inputs"][number]>();
  for (const [inputKind, snapshot] of [[kind, record] as const, ...joins]) {
    if (!snapshot) continue;
    // Member lineage owns this exact nested profile projection; full User
    // content is a separate input so no contributed field escapes its proof.
    const user = snapshot.user as SourceRecord | undefined;
    const projected = inputKind === "Member" && user ? { ...snapshot,
      user: { id: user.id, email: user.email, displayName: user.displayName } } : snapshot;
    inputs.set(`${inputKind}:${snapshot.id}`, { kind: inputKind, id: snapshot.id, snapshot: projected });
  }
  return { kind, record, title, content, rawContent: null, contentHash: lineageContentFingerprint(kind, record),
    inputs: [...inputs.values()], metadata };
}

/** Canonical source bytes and every joined content contributor, loaded in the source tenant. */
export async function loadCanonicalKnowledgeSources(params: {
  workspaceId: string; sourceType: KnowledgeSourceType; sourceIds?: string[]; take: number;
}, db: Db = prisma): Promise<CanonicalKnowledgeSource[]> {
  const { workspaceId, sourceType } = params;
  const id = params.sourceIds ? { id: { in: params.sourceIds } } : {};
  const query = { take: params.take, orderBy: { id: "asc" as const } };
  const where = { ...id, workspaceId, archivedAt: null };
  if (sourceType === "ACTION" || sourceType === "TENSION") {
    const include = { author: true, assigneeMember: { include: { user: true } }, circle: true } as const;
    if (sourceType === "ACTION") {
      const rows = await db.action.findMany({ ...query, where, include });
      return rows.filter(row => (!row.circle || row.circle.workspaceId === workspaceId)
        && (!row.assigneeMember || row.assigneeMember.workspaceId === workspaceId)).map(row => source("Action", row, row.title, [
        `# Action: ${row.title}`, `**Status:** ${row.status} | **Due:** ${row.dueAt ? row.dueAt.toISOString() : "None"}`,
        `**Author:** ${row.author.displayName || "Unknown"}`,
        `**Circle:** ${row.circle?.name || "None"} | **Assigned to:** ${row.assigneeMember?.user.displayName || "Unassigned"}`,
        `**Created:** ${row.createdAt.toISOString()}`, row.bodyMd ? `\n${row.bodyMd}` : "",
      ].filter(Boolean).join("\n"), [["User", row.author], ["Member", row.assigneeMember],
        ["User", row.assigneeMember?.user], ["Circle", row.circle]], { status: row.status }));
    }
    const rows = await db.tension.findMany({ ...query, where, include: { ...include, raisedByMember: { include: { user: true } } } });
    return rows.filter(row => (!row.circle || row.circle.workspaceId === workspaceId)
      && (!row.assigneeMember || row.assigneeMember.workspaceId === workspaceId)
      && (!row.raisedByMember || row.raisedByMember.workspaceId === workspaceId)).map(row => source("Tension", row, row.title, [
      `# Tension: ${row.title}`, `**Status:** ${row.status} | **Priority:** ${row.priority}`,
      `**Author:** ${row.author.displayName || "Unknown"}`, `**Raised by:** ${row.raisedByMember?.user.displayName || "Unknown"}`,
      `**Circle:** ${row.circle?.name || "None"} | **Assigned to:** ${row.assigneeMember?.user.displayName || "Unassigned"}`,
      `**Created:** ${row.createdAt.toISOString()}`, row.bodyMd ? `\n${row.bodyMd}` : "",
    ].filter(Boolean).join("\n"), [["User", row.author], ["Member", row.assigneeMember], ["User", row.assigneeMember?.user],
      ["Member", row.raisedByMember], ["User", row.raisedByMember?.user], ["Circle", row.circle]], { status: row.status }));
  }
  if (sourceType === "CIRCLE") {
    return (await db.circle.findMany({ ...query, where })).map(row => source("Circle", row, row.name, [
      `# Circle: ${row.name}`, `**Purpose:**\n${row.purposeMd || "Not specified"}`, `**Domain:**\n${row.domainMd || "Not specified"}`,
    ].join("\n\n"), []));
  }
  if (sourceType === "ROLE") {
    return (await db.role.findMany({ ...query, where: { ...id, archivedAt: null, circle: { workspaceId, archivedAt: null } }, include: { circle: true } }))
      .map(row => source("Role", row, row.name, [`# Role: ${row.name}`, `**Circle:** ${row.circle.name}`,
        `**Purpose:**\n${row.purposeMd || "Not specified"}`,
        `**Accountabilities:**\n${row.accountabilities.length ? row.accountabilities.map(value => `- ${value}`).join("\n") : "None"}`,
      ].join("\n\n"), [["Circle", row.circle]]));
  }
  if (sourceType === "SLACK") {
    const rows = await db.communicationMessage.findMany({ ...query, where: { ...id, workspaceId, provider: "SLACK",
      text: { not: null }, textRedactedAt: null, isBot: false, isHidden: false, isDeleted: false,
      installation: { workspaceId, status: "ACTIVE", disconnectedAt: null } } });
    if (!rows.length) return [];
    const channels = await db.communicationChannel.findMany({ where: { workspaceId, provider: "SLACK", kind: "PUBLIC",
      isIngestEnabled: true, isArchived: false,
      OR: rows.map(row => ({ installationId: row.installationId, externalChannelId: row.externalChannelId })) } });
    return rows.flatMap(row => {
      const channel = channels.find(item => item.installationId === row.installationId && item.externalChannelId === row.externalChannelId);
      if (!channel || !row.text) return [];
      const label = channel.name ? `#${channel.name}` : row.externalChannelId;
      return [source("CommunicationMessage", row, `Slack ${label}`, [`Slack message in ${label}`,
        row.messageTs ? `Posted at ${row.messageTs.toISOString()}` : null,
        row.externalUserId ? `Author: ${row.externalUserId}` : null, row.threadExternalId ? `Thread: ${row.threadExternalId}` : null,
        "", row.text,
      ].filter(value => value !== null).join("\n"), [["CommunicationChannel", channel]], {
        installationId: row.installationId, externalChannelId: row.externalChannelId, externalMessageId: row.externalMessageId,
        externalUserId: row.externalUserId, threadExternalId: row.threadExternalId,
        messageTs: row.messageTs?.toISOString() ?? null, permalink: row.permalink,
      })];
    });
  }
  return [];
}

export async function loadCanonicalKnowledgeSource(params: {
  workspaceId: string; sourceType: KnowledgeSourceType; sourceId: string;
}, db: Db = prisma): Promise<CanonicalKnowledgeSource | null> {
  return (await loadCanonicalKnowledgeSources({ ...params, sourceIds: [params.sourceId], take: 1 }, db))[0] ?? null;
}
