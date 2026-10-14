import { createHash } from "node:crypto";
import type { BrainSource } from "@prisma/client";

type DerivationSource = Pick<BrainSource,
  "id" | "workspaceId" | "accessDomain" | "sourceType" | "tier" | "title" | "channel"
  | "content" | "ingestionGuidanceMd" | "fileStorageKey" | "fileMimeType"> & Partial<Pick<BrainSource, "metadata" | "authorMemberId" | "fileName" | "fileSizeBytes" | "externalId" | "createdAt">>;

function canonicalJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}

export type BrainArticleDerivationV1 = {
  version: 1;
  origin: "brain-absorb";
  agentRunId: string;
  sources: Array<{ sourceId: string; fingerprint: string }>;
};

/** The source fields that the absorption model may use, plus the stored file identity. */
export function brainSourceContentFingerprint(source: DerivationSource) {
  return createHash("sha256").update(JSON.stringify([
    "brain-source-content-v2", source.id, source.workspaceId, source.accessDomain,
    source.sourceType, source.tier, source.title, source.channel, source.content,
    source.ingestionGuidanceMd, source.fileStorageKey, source.fileMimeType,
    canonicalJson(source.metadata ?? null), source.authorMemberId ?? null, source.fileName ?? null, source.fileSizeBytes ?? null,
    source.externalId ?? null, canonicalJson(source.createdAt ?? null),
  ])).digest("hex");
}
