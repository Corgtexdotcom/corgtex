import { createHash } from "node:crypto";
import type { BrainSource } from "@prisma/client";

type DerivationSource = Pick<BrainSource,
  "id" | "workspaceId" | "accessDomain" | "sourceType" | "tier" | "title" | "channel"
  | "content" | "ingestionGuidanceMd" | "fileStorageKey" | "fileMimeType">;

export type BrainArticleDerivationV1 = {
  version: 1;
  origin: "brain-absorb";
  agentRunId: string;
  sources: Array<{ sourceId: string; fingerprint: string }>;
};

/** The source fields that the absorption model may use, plus the stored file identity. */
export function brainSourceContentFingerprint(source: DerivationSource) {
  return createHash("sha256").update(JSON.stringify([
    "brain-source-content-v1", source.id, source.workspaceId, source.accessDomain,
    source.sourceType, source.tier, source.title, source.channel, source.content,
    source.ingestionGuidanceMd, source.fileStorageKey, source.fileMimeType,
  ])).digest("hex");
}
