import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

interface Message {
  event: "ready" | "prepared" | "complete" | "failed";
  error?: string;
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
    run: (sourceId: string, gatePreparation = true) => send(child, { command: "run", sourceId, gatePreparation }),
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
  let gatePreparation = false;
  let releasePreparation: ((error?: string) => void) | undefined;
  // Only the remote model boundary is substituted. Native provider reads,
  // durable source claims, receipts, Knowledge writes and Prisma TXs are real.
  defaultModelGateway.embed = async (request) => {
    if (gatePreparation) {
      gatePreparation = false;
      await new Promise<void>((resolve, reject) => {
        releasePreparation = (error) => error ? reject(new Error(error)) : resolve();
        process.send?.({ event: "prepared" });
      });
    }
    return {
      embeddings: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0.1, 0.2, 0.3]),
      usage: { provider: "synthetic", model: "synthetic-sql-race", inputTokens: 1, outputTokens: 0 },
    };
  };
  process.on("message", (message: { command: string; sourceId?: string; gatePreparation?: boolean; error?: string }) => {
    if (message.command === "release") {
      releasePreparation?.(message.error);
      releasePreparation = undefined;
    } else if (message.command === "run" && message.sourceId) {
      gatePreparation = message.gatePreparation ?? true;
      void syncExternalDataSource(message.sourceId).then(
        () => process.send?.({ event: "complete" }),
        (error: unknown) => process.send?.({ event: "failed", error: error instanceof Error ? error.message : String(error) }),
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
