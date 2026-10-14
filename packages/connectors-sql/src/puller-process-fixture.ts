import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

interface Message {
  event: "ready" | "prepared" | "complete" | "failed" | "publication-ready" | "read";
  read?: { fetched: boolean; count: number; searchIds: string[]; downstreamReadable: boolean };
  error?: string;
  metrics?: { durationMs: number; peakRssBytes: number; modelBatches: number; embeddedChunks: number; dimensions: number };
}

/** A separate Node process, module cache, model gateway and Prisma pool per run. */
export function startSqlIngestionProcess(environment: Record<string, string>) {
  const child = fork(fileURLToPath(import.meta.url), ["sql-ingestion-child"], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let diagnostics = "";
  let exited = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data: Buffer) => { diagnostics = (diagnostics + data.toString()).slice(-16_000); });
  }
  child.on("message", (message: Message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  child.on("exit", () => {
    exited = true;
    for (const listener of listeners) listener();
  });

  async function waitFor(event: Message["event"], timeoutMs = 30_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`SQL child timed out awaiting ${event}: ${diagnostics}`)), timeoutMs);
      const check = () => {
        const index = messages.findIndex((message) => message.event === event);
        if (index >= 0) return finish(undefined, messages.splice(index, 1)[0]);
        const failure = messages.find((message) => message.event === "failed");
        if (failure) return finish(new Error(failure.error));
        if (event === "failed" && messages.some((message) => message.event === "complete")) {
          return finish(new Error("SQL child completed while expecting a failed publication"));
        }
        if (exited) finish(new Error(`SQL child exited awaiting ${event}: ${diagnostics}`));
      };
      function finish(error?: Error, message?: Message) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(message!);
      }
      listeners.add(check);
      check();
    });
  }

  return {
    pid: child.pid,
    ready: () => waitFor("ready"),
    run: (sourceId: string, gatePreparation = true, gatePublication = false) => send(child, { command: "run", sourceId, gatePreparation, gatePublication }),
    publicationReady: () => waitFor("publication-ready"),
    releasePublication: () => send(child, { command: "release-publication" }),
    read: async (workspaceId: string, userId: string, chunkId: string) => {
      await send(child, { command: "read", workspaceId, userId, chunkId });
      return waitFor("read", 120_000);
    },
    prepared: () => waitFor("prepared"),
    release: (error?: string) => send(child, { command: "release", error }),
    complete: (timeoutMs?: number) => waitFor("complete", timeoutMs),
    failed: () => waitFor("failed"),
    close: async () => {
      if (exited) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    },
  };
}

function send(child: ChildProcess, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => child.send(message, (error) => error ? reject(error) : resolve()));
}

async function runChild() {
  const [{ defaultModelGateway }, { syncExternalDataSource }] = await Promise.all([
    import("@corgtex/models"),
    import("./puller"),
  ]);
  let gatePublication = false, nativeCloses = 0;
  let releasePublication: (() => void) | undefined;
  const originalEnd = pg.Client.prototype.end;
  // Pause after the final actual provider replay has completed and closed, but
  // before the application publication transaction starts. No provider response
  // or source authority is fabricated by this deterministic test barrier.
  pg.Client.prototype.end = (async function(this: pg.Client) {
    await Reflect.apply(originalEnd, this, []);
    nativeCloses++;
    if (gatePublication && nativeCloses === 2) {
      gatePublication = false;
      await new Promise<void>((resolve) => {
        releasePublication = resolve;
        process.send?.({ event: "publication-ready" });
      });
    }
  }) as typeof pg.Client.prototype.end;
  let gatePreparation = false;
  let peakRssBytes = 0, modelBatches = 0, embeddedChunks = 0;
  const dimensions = Number(process.env.SQL_TEST_VECTOR_DIMENSIONS ?? "1536");
  let releasePreparation: ((error?: string) => void) | undefined;
  // Only the remote model boundary is substituted. Native provider reads,
  // durable source claims, receipts, Knowledge writes and Prisma TXs are real.
  defaultModelGateway.embed = async (request) => {
    modelBatches++;
    embeddedChunks += Array.isArray(request.input) ? request.input.length : 1;
    if (gatePreparation) {
      gatePreparation = false;
      await new Promise<void>((resolve, reject) => {
        releasePreparation = (error) => error ? reject(new Error(error)) : resolve();
        process.send?.({ event: "prepared" });
      });
    }
    return {
      embeddings: (Array.isArray(request.input) ? request.input : [request.input]).map(() =>
        Array.from({ length: dimensions }, (_, index) => ((index % 31) - 15) / 100)),
      usage: { provider: "synthetic", model: "synthetic-sql-race", inputTokens: 1, outputTokens: 0 },
    };
  };
  defaultModelGateway.rerank = async ({ documents, topK }) => ({
    results: documents.slice(0, topK).map((document, index) => ({ index, score: 1, document })),
    usage: { provider: "synthetic", model: "synthetic-rerank", inputTokens: 1, outputTokens: 0 },
  });
  async function read(message: { workspaceId?: string; userId?: string; chunkId?: string }) {
    const { prisma } = await import("@corgtex/shared");
    const { fetchReadableKnowledgeChunk, countReadableKnowledgeChunks, searchIndexedKnowledge } = await import("@corgtex/knowledge");
    const { captureArtifactInputProof, isArtifactInputProofReadable } = await import("@corgtex/domain");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: message.userId! } });
    const actor = { kind: "user" as const, user }, workspaceId = message.workspaceId!, chunkId = message.chunkId!;
    const fetched = await fetchReadableKnowledgeChunk(actor, workspaceId, chunkId);
    const count = await countReadableKnowledgeChunks(actor, workspaceId, ["EXTERNAL_DATABASE"]);
    const search = await searchIndexedKnowledge({ actor, workspaceId, query: "committed payload synthetic", sourceTypes: ["EXTERNAL_DATABASE"] });
    let downstreamReadable = false;
    try {
      const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "KnowledgeChunk", id: chunkId }]);
      downstreamReadable = roots.length > 0 && await isArtifactInputProofReadable(actor, workspaceId, roots);
    } catch (error) {
      if (!(error instanceof Error) || !/source|input|read|access/i.test(error.message)) throw error;
    }
    process.send?.({ event: "read", read: { fetched: fetched !== null, count, searchIds: search.map((item) => item.chunkId), downstreamReadable } });
  }
  process.on("message", (message: { command: string; sourceId?: string; gatePreparation?: boolean; gatePublication?: boolean; error?: string; workspaceId?: string; userId?: string; chunkId?: string }) => {
    if (message.command === "read") {
      void read(message).catch((error: unknown) => process.send?.({ event: "failed", error: error instanceof Error ? error.message : String(error) }));
    } else if (message.command === "release-publication") {
      releasePublication?.(); releasePublication = undefined;
    } else if (message.command === "release") {
      releasePreparation?.(message.error);
      releasePreparation = undefined;
    } else if (message.command === "run" && message.sourceId) {
      gatePreparation = message.gatePreparation ?? true;
      gatePublication = message.gatePublication ?? false; nativeCloses = 0;
      const started = performance.now();
      peakRssBytes = process.memoryUsage().rss; modelBatches = 0; embeddedChunks = 0;
      const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
      const finish = (event: "complete" | "failed", error?: string) => {
        clearInterval(monitor);
        process.send?.({ event, error, metrics: { durationMs: performance.now() - started,
          peakRssBytes: Math.max(peakRssBytes, process.memoryUsage().rss), modelBatches, embeddedChunks, dimensions } });
      };
      void syncExternalDataSource(message.sourceId).then(
        () => finish("complete"),
        (error: unknown) => finish("failed", error instanceof Error ? error.message : String(error)),
      );
    }
  });
  process.send?.({ event: "ready" });
}

if (process.argv[2] === "sql-ingestion-child") {
  void runChild().catch((error: unknown) => {
    process.send?.({ event: "failed", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
