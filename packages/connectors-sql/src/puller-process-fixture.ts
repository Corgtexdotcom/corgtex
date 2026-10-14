import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

interface Message {
  event: "ready" | "prepared" | "complete" | "failed" | "publication-ready" | "read" | "dispatch-complete";
  read?: { fetched: boolean; count: number; searchIds: string[]; downstreamReadable: boolean };
  error?: string;
  metrics?: { durationMs: number; peakRssBytes: number; modelBatches: number; embeddedChunks: number; dimensions: number; osMaxRssBytes: number; rssLimitBytes: number | null; phasePeakRssBytes: Record<string, number> };
}

/** A separate Node process, module cache, model gateway and Prisma pool per run. */
export function startSqlIngestionProcess(environment: Record<string, string>, mode: "ingestion" | "web-reader" | "mcp-reader" | "outbox" = "ingestion") {
  const child = fork(fileURLToPath(import.meta.url), ["sql-ingestion-child", mode], {
    execArgv: ["--import", "tsx", ...(environment.SQL_TEST_HEAP_MB ? [`--max-old-space-size=${Number(environment.SQL_TEST_HEAP_MB)}`] : [])],
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
    run: (sourceId: string, gatePreparation = true, gatePublication = false, claimBarrier?: string) => send(child, { command: "run", sourceId, gatePreparation, gatePublication, claimBarrier }),
    dispatchAgain: () => send(child, { command: "dispatch-again" }),
    dispatchComplete: () => waitFor("dispatch-complete", 120_000),
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
  const mode = process.argv[3] ?? "ingestion";
  const workerId = `sql-process-worker-${process.pid}`;
  let phase = "bootstrap", peakRssBytes = 0, modelBatches = 0, embeddedChunks = 0;
  const phasePeakRssBytes: Record<string, number> = {};
  const rssLimitBytes = Number(process.env.SQL_TEST_RSS_LIMIT_BYTES ?? "0") || null;
  const osMaxRssBytes = () => process.resourceUsage().maxRSS * 1024;
  // Enforce the entire process, including native buffers/Prisma/tsx, not just V8.
  const rssGuard = setInterval(() => {
    phasePeakRssBytes[phase] = Math.max(phasePeakRssBytes[phase] ?? 0, process.memoryUsage().rss);
    if (rssLimitBytes && osMaxRssBytes() > rssLimitBytes) {
      process.send?.({ event: "failed", error: `SQL process RSS budget exceeded: ${osMaxRssBytes()} > ${rssLimitBytes}; ${JSON.stringify({ phase, modelBatches, embeddedChunks, phasePeakRssBytes, memory: process.memoryUsage() })}` },
        () => process.exit(1));
    }
  }, 10);
  rssGuard.unref();
  const { defaultModelGateway } = await import("@corgtex/models");
  let runPendingJobs: typeof import("../../workflows/src/outbox")["runPendingJobs"] | undefined;
  let syncExternalDataSource: typeof import("./puller")["syncExternalDataSource"] | undefined;
  if (mode === "ingestion") {
    syncExternalDataSource = (await import("./puller")).syncExternalDataSource;
  } else if (mode === "outbox") {
    runPendingJobs = (await import("../../workflows/src/outbox")).runPendingJobs;
  } else if (mode === "web-reader") {
    // A genuine cold serving process: no ingestion module has run. Exercise the
    // production Next Node bootstrap, then the ordinary Knowledge entrypoint.
    process.env.NEXT_RUNTIME = "nodejs";
    await (await import("../../../apps/web/instrumentation")).register();
    await import("@corgtex/knowledge");
  } else if (mode === "mcp-reader") {
    await import("../../mcp/src/server");
    await import("@corgtex/knowledge");
  } else {
    throw new Error("Unknown SQL test process mode");
  }
  let claimBarrier: string | undefined;
  if (mode === "outbox" && process.env.SQL_TEST_CLAIM_BARRIER === "1") {
    const { prisma } = await import("@corgtex/shared");
    const originalTransaction = prisma.$transaction;
    const client = globalThis.prismaGlobal;
    if (!client) throw new Error("Synthetic Prisma client was not initialized");
    // Test-only barrier in the real claim SQL after eligible IDs have been
    // materialized, before head/candidate row locking. All rows remain native PG.
    client.$transaction = (async (operation: unknown, ...options: unknown[]) => {
      if (typeof operation !== "function") return Reflect.apply(originalTransaction, prisma, [operation, ...options]);
      return Reflect.apply(originalTransaction, prisma, [async (tx: import("@prisma/client").Prisma.TransactionClient) => operation(new Proxy(tx, {
        get(target, property) {
          if (property !== "$queryRaw") return Reflect.get(target, property);
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (claimBarrier && Array.isArray(strings) && strings.join("").includes("WITH eligible AS")) {
              const barrier = claimBarrier;
              claimBarrier = undefined;
              const parts = strings.map((part) => part.replace(
                "), head AS (", `), admission_barrier AS MATERIALIZED (SELECT ${barrier}() FROM eligible LIMIT 1), head AS (`
              ).replace('SELECT job.id, job.type FROM "WorkflowJob" AS job JOIN eligible USING (id)', 'SELECT job.id, job.type FROM "WorkflowJob" AS job JOIN eligible USING (id) CROSS JOIN admission_barrier'));
              return Reflect.apply(target.$queryRaw, target, [Object.assign(parts, { raw: parts }), ...values]);
            }
            return Reflect.apply(target.$queryRaw, target, [strings, ...values]);
          };
        },
      })), ...options]);
    }) as typeof prisma.$transaction;
  }
  let gatePublication = false, nativeCloses = 0;
  let releasePublication: (() => void) | undefined;
  const originalEnd = pg.Client.prototype.end;
  // Pause after the final actual provider replay has completed and closed, but
  // before the application publication transaction starts. No provider response
  // or source authority is fabricated by this deterministic test barrier.
  pg.Client.prototype.end = (async function(this: pg.Client) {
    await Reflect.apply(originalEnd, this, []);
    nativeCloses++;
    if (nativeCloses === 1) phase = "publication-validation";
    if (nativeCloses === 2) phase = "publication";
    if (gatePublication && nativeCloses === 2) {
      gatePublication = false;
      await new Promise<void>((resolve) => {
        releasePublication = resolve;
        process.send?.({ event: "publication-ready" });
      });
    }
  }) as typeof pg.Client.prototype.end;
  let gatePreparation = false;
  const dimensions = Number(process.env.SQL_TEST_VECTOR_DIMENSIONS ?? "1536");
  let releasePreparation: ((error?: string) => void) | undefined;
  // Only the remote model boundary is substituted. Native provider reads,
  // durable source claims, receipts, Knowledge writes and Prisma TXs are real.
  defaultModelGateway.embed = async (request) => {
    modelBatches++;
    phase = "model-preparation";
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
    phase = "read";
    const { prisma } = await import("@corgtex/shared");
    const { fetchReadableKnowledgeChunk, countReadableKnowledgeChunks, searchIndexedKnowledge } = await import("@corgtex/knowledge");
    const { captureArtifactInputProof, isArtifactInputProofReadable } = await import("@corgtex/domain");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: message.userId! } });
    const actor = { kind: "user" as const, user }, workspaceId = message.workspaceId!, chunkId = message.chunkId!;
    phase = "reader-fetch";
    const fetched = await fetchReadableKnowledgeChunk(actor, workspaceId, chunkId);
    phase = "reader-count";
    const count = await countReadableKnowledgeChunks(actor, workspaceId, ["EXTERNAL_DATABASE"]);
    phase = "reader-search";
    let search = await searchIndexedKnowledge({ actor, workspaceId, query: "committed payload synthetic", sourceTypes: ["EXTERNAL_DATABASE"] });
    if (mode === "mcp-reader") {
      const { createCorgtexMcpServer } = await import("../../mcp/src/server");
      const { captureMcpOAuthGrantEpoch, mcpScopesHash } = await import("@corgtex/shared");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const scopes = ["brain:read"];
      const application = await prisma.mcpOAuthClient.create({ data: { clientId: randomUUID(), name: "Synthetic cold MCP reader", redirectUris: [], scopes } });
      const token = await prisma.mcpOAuthAccessToken.create({ data: { clientId: application.id, userId: user.id, workspaceId,
        instanceSlug: "synthetic", tokenHash: randomUUID(), scopes, expiresAt: new Date(Date.now() + 60_000) } });
      const grantEpoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, workspaceId, token.id));
      const server = createCorgtexMcpServer({ actor, workspaceId, authKind: "oauth", scopes,
        mcpOrigin: { kind: "oauth", id: token.id, workspaceId, grantEpoch, scopeHash: mcpScopesHash(scopes) } });
      const client = new Client({ name: "cold-reader-test", version: "1.0.0" });
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport); await client.connect(clientTransport);
        const result = await client.callTool({ name: "search_knowledge", arguments: { query: "committed payload synthetic", limit: 5 } });
        if (result.isError || !Array.isArray(result.content) || result.content[0]?.type !== "text") throw new Error("Cold MCP search did not return a successful result");
        search = JSON.parse(result.content[0].text as string) as typeof search;
      } finally {
        await client.close(); await server.close();
        await prisma.mcpOAuthClient.delete({ where: { id: application.id } });
      }
    }
    phase = "reader-downstream";
    let downstreamReadable = false;
    try {
      const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "KnowledgeChunk", id: chunkId }]);
      downstreamReadable = roots.length > 0 && await isArtifactInputProofReadable(actor, workspaceId, roots);
    } catch (error) {
      if (!(error instanceof Error) || !/source|input|read|access/i.test(error.message)) throw error;
    }
    process.send?.({ event: "read", metrics: { durationMs: 0, peakRssBytes: process.memoryUsage().rss, osMaxRssBytes: osMaxRssBytes(), rssLimitBytes, phasePeakRssBytes, modelBatches, embeddedChunks, dimensions }, read: { fetched: fetched !== null, count, searchIds: search.map((item) => item.chunkId), downstreamReadable } });
  }
  process.on("message", (message: { command: string; sourceId?: string; gatePreparation?: boolean; gatePublication?: boolean; claimBarrier?: string; error?: string; workspaceId?: string; userId?: string; chunkId?: string }) => {
    if (message.command === "read") {
      void read(message).catch((error: unknown) => process.send?.({ event: "failed", error: error instanceof Error ? error.message : String(error) }));
    } else if (message.command === "release-publication") {
      releasePublication?.(); releasePublication = undefined;
    } else if (message.command === "release") {
      releasePreparation?.(message.error);
      releasePreparation = undefined;
    } else if (message.command === "dispatch-again" && runPendingJobs) {
      void runPendingJobs(workerId, 25, 5).then(
        () => process.send?.({ event: "dispatch-complete" }),
        (error: unknown) => process.send?.({ event: "failed", error: String(error) }),
      );
    } else if (message.command === "run" && message.sourceId) {
      phase = "claim-and-native-capture";
      if (message.claimBarrier && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(message.claimBarrier)) throw new Error("Invalid synthetic claim barrier");
      claimBarrier = message.claimBarrier;
      gatePreparation = message.gatePreparation ?? true;
      gatePublication = message.gatePublication ?? false; nativeCloses = 0;
      const started = performance.now();
      peakRssBytes = process.memoryUsage().rss; modelBatches = 0; embeddedChunks = 0;
      const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
      const finish = (event: "complete" | "failed", error?: string) => {
        clearInterval(monitor);
        process.send?.({ event, error, metrics: { durationMs: performance.now() - started,
          peakRssBytes: Math.max(peakRssBytes, process.memoryUsage().rss), osMaxRssBytes: osMaxRssBytes(), rssLimitBytes, phasePeakRssBytes, modelBatches, embeddedChunks, dimensions } });
      };
      if (!syncExternalDataSource && !runPendingJobs) throw new Error("Cold reader cannot start ingestion");
      void (runPendingJobs ? runPendingJobs(workerId, 25, 5) : syncExternalDataSource!(message.sourceId)).then(
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
