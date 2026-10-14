import type { KnowledgeSourceType, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import {
  AppError,
  captureConversationInputReceipt,
  collectConversationInputReceipts,
  validateConversationInputReceipt,
  rebaseConversationInputReceipt,
  type ConversationInputFragment,
  type ConversationInputReceipt,
  type LineageInput,
  type LineageKind,
  type LineageRoot,
} from "@corgtex/domain";

export type ConversationKnowledgeResult = {
  chunkId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  chunkIndex: number;
  snippet: string;
  score: number;
};

function unprovenInput(error: unknown) {
  return error instanceof AppError && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One collector per turn. Register every dynamic model input before using it. */
export function createConversationLineageCollector(actor: AppActor, workspaceId: string) {
  const fragments: ConversationInputFragment[] = [];
  let incomplete = false;

  async function capture<T>(value: T, inputs: Array<LineageInput & { snapshot?: Record<string, unknown> }>) {
    const receipt = await captureConversationInputReceipt({ actor, workspaceId, value, inputs });
    fragments.push({ value, receipt });
    return value;
  }

  return {
    capture,

    async captureTrusted<T>(value: T, roots: readonly LineageRoot[]) {
      const receipt = await captureConversationInputReceipt({ actor, workspaceId, value, trustedRoots: roots });
      fragments.push({ value, receipt });
      return value;
    },

    /** A tool must return a receipt minted by its trusted producer, not source IDs inferred from JSON. */
    async addReceipt<T>(value: T, receipt: ConversationInputReceipt) {
      await validateConversationInputReceipt({ actor, workspaceId, value, receipt });
      fragments.push({ value, receipt });
      return value;
    },

    /** Filter before formatting, counts, ranking and history limits. Omitted inputs do not enter the model. */
    async admitRecords<T extends { id: string }>(kind: LineageKind, records: readonly T[],
      additionalInputs?: (value: T) => Array<LineageInput & { snapshot?: Record<string, unknown> }>) {
      const admitted: T[] = [];
      for (const value of records) {
        try { admitted.push(await capture(value, [{ kind, id: value.id, snapshot: value }, ...(additionalInputs?.(value) ?? [])])); }
        catch (error) { if (!unprovenInput(error)) throw error; }
      }
      return admitted;
    },

    /** Bind eager/search-tool results to authoritative SQL chunks before any result text is supplied. */
    async admitKnowledgeResults(results: readonly unknown[]): Promise<ConversationKnowledgeResult[]> {
      const ids = [...new Set(results.flatMap((value) => record(value) && typeof value.chunkId === "string" ? [value.chunkId] : []))];
      if (!ids.length) return [];
      const chunks = await prisma.knowledgeChunk.findMany({ where: { workspaceId, id: { in: ids } } });
      const current = new Map(chunks.map((chunk) => [chunk.id, chunk]));
      const admitted: ConversationKnowledgeResult[] = [];
      for (const value of results) {
        if (!record(value) || typeof value.chunkId !== "string") continue;
        const chunk = current.get(value.chunkId);
        if (!chunk || value.sourceType !== chunk.sourceType || value.sourceId !== chunk.sourceId
          || value.chunkIndex !== chunk.chunkIndex || value.snippet !== chunk.content.slice(0, 400)
          || (value.title !== chunk.sourceTitle && !(value.title === "Untitled" && !chunk.sourceTitle))
          || typeof value.score !== "number" || !Number.isFinite(value.score)) continue;
        // Only these verified fields enter context; arbitrary extra text in cached/external JSON is dropped.
        const supplied: ConversationKnowledgeResult = {
          chunkId: chunk.id, sourceType: chunk.sourceType, sourceId: chunk.sourceId,
          title: value.title as string | null, chunkIndex: chunk.chunkIndex,
          snippet: chunk.content.slice(0, 400), score: value.score,
        };
        try { admitted.push(await capture(supplied, [{ kind: "KnowledgeChunk", id: chunk.id, snapshot: chunk }])); }
        catch (error) { if (!unprovenInput(error)) throw error; }
      }
      return admitted;
    },

    /** Once unreceipted text entered a model, later SQL reads cannot prove that output independent. */
    markIncomplete() { incomplete = true; },

    async assertReadable(db?: Prisma.TransactionClient) {
      if (incomplete) throw new AppError(409, "UNKNOWN_LINEAGE", "Conversation context contains unproven inputs. Please retry.");
      await collectConversationInputReceipts({ actor, workspaceId, fragments, db });
    },

    async preserveConsumedRevisions() {
      for (const fragment of fragments) await rebaseConversationInputReceipt({ actor, workspaceId, ...fragment });
    },

    /** Return only after current checks, then forward to every output producer in its write transaction. */
    async roots(db?: Prisma.TransactionClient) {
      if (incomplete) throw new AppError(409, "UNKNOWN_LINEAGE", "Conversation context contains unproven inputs. Please retry.");
      return collectConversationInputReceipts({ actor, workspaceId, fragments, db });
    },
  };
}
