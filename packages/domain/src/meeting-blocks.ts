export type MeetingBlockKind =
  | "check_in"
  | "update"
  | "tension"
  | "proposal_discussion"
  | "decision"
  | "planning"
  | "custom";

export type MeetingBlockRelatedRecord = {
  entityType: "Action" | "Tension" | "Proposal";
  entityId: string;
  title?: string | null;
};

export type MeetingBlock = {
  sequence: number;
  title: string;
  kind: MeetingBlockKind | string;
  summaryMd: string;
  sourceQuote?: string | null;
  relatedRecords?: MeetingBlockRelatedRecord[];
};

export type MeetingBlocksJson = {
  version: 1;
  blocks: MeetingBlock[];
};

export type MeetingBlockReference = {
  sequence?: number | null;
  title?: string | null;
  kind?: string | null;
};

export const MEETING_BLOCK_METADATA_PREFIX = "**MEETING BLOCK:**";
export const MEETING_BLOCK_KIND_PREFIX = "**BLOCK KIND:**";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max?: number) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return max && trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeKind(value: unknown): MeetingBlockKind | string {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "custom";
}

function normalizeRelatedRecords(value: unknown): MeetingBlockRelatedRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const entityType = item.entityType === "Action" || item.entityType === "Tension" || item.entityType === "Proposal"
      ? item.entityType
      : null;
    const entityId = text(item.entityId);
    if (!entityType || !entityId) return [];
    return [{
      entityType,
      entityId,
      title: text(item.title) || null,
    }];
  });
}

export function normalizeMeetingBlocks(value: unknown): MeetingBlocksJson {
  const root = isRecord(value) ? value : {};
  const rawBlocks = Array.isArray(root.blocks) ? root.blocks : Array.isArray(value) ? value : [];
  const blocks = rawBlocks.flatMap((item, index): MeetingBlock[] => {
    if (!isRecord(item)) return [];
    const title = text(item.title, 120);
    const summaryMd = text(item.summaryMd ?? item.summary, 1200);
    if (!title || !summaryMd) return [];
    const sequence = numberValue(item.sequence) ?? index + 1;
    return [{
      sequence,
      title,
      kind: normalizeKind(item.kind),
      summaryMd,
      sourceQuote: text(item.sourceQuote, 240) || null,
      relatedRecords: normalizeRelatedRecords(item.relatedRecords),
    }];
  }).sort((left, right) => left.sequence - right.sequence);

  return {
    version: 1,
    blocks: blocks.map((block, index) => ({
      ...block,
      sequence: Number.isFinite(block.sequence) && block.sequence > 0 ? block.sequence : index + 1,
    })),
  };
}

export function resolveMeetingBlockReference(
  blocksJson: unknown,
  reference: MeetingBlockReference,
): MeetingBlock | null {
  const blocks = normalizeMeetingBlocks(blocksJson).blocks;
  if (blocks.length === 0) return null;

  if (reference.sequence && Number.isFinite(reference.sequence)) {
    const bySequence = blocks.find((block) => block.sequence === reference.sequence);
    if (bySequence) return bySequence;
  }

  const title = text(reference.title).toLowerCase();
  if (title) {
    const byTitle = blocks.find((block) => block.title.toLowerCase() === title);
    if (byTitle) return byTitle;
  }

  const kind = text(reference.kind).toLowerCase();
  if (kind) {
    const byKind = blocks.find((block) => block.kind.toLowerCase() === normalizeKind(kind));
    if (byKind) return byKind;
  }

  return null;
}

export function prependMeetingBlockContext(bodyMd: string, block: MeetingBlock | null) {
  const body = bodyMd.trim();
  if (!block || body.startsWith(MEETING_BLOCK_METADATA_PREFIX)) return body;
  return [
    `${MEETING_BLOCK_METADATA_PREFIX} ${block.title}`,
    `${MEETING_BLOCK_KIND_PREFIX} ${block.kind.replace(/_/g, " ")}`,
    "",
    body,
  ].join("\n");
}
