import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const image = "pgvector/pgvector:pg16";

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function localConnection(connectionString: string): pg.Client {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
  const target = (client as pg.Client & {
    connectionParameters: {
      host: string; database: string; user: string; password: unknown; port: number; ssl: unknown;
    };
  }).connectionParameters;
  if (!/^\/(tmp|workspace)\//.test(target.host) ||
      !/^pun85_[a-z0-9_]+$/.test(target.database) || target.user !== "postgres" ||
      target.password || target.port !== 5432 || target.ssl) {
    throw new Error("PUN85_TEST_DATABASE_URL must name a disposable pun85_* database on a /tmp or /workspace Unix socket, user postgres, port 5432, without a password or SSL. DATABASE_URL is never used.");
  }
  return client;
}

async function docker(args: string[]) {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://")) {
    throw new Error("SQL fixtures require a local Docker Unix-socket engine");
  }
  return execute("docker", args, { timeout: 15_000, maxBuffer: 128 * 1024 });
}

export interface SqlTestFixture {
  connectionString: string;
  writer: pg.Client;
  schema: string;
  table(name: string, schema?: string): string;
  createSchema(suffix: string): Promise<string>;
  close(): Promise<void>;
}

/** Never falls through to application DATABASE_URL or downloads an image. */
export async function createSqlTestFixture(): Promise<SqlTestFixture> {
  const suffix = randomBytes(8).toString("hex");
  const schema = `pun85_sql_${suffix}`;
  const schemas = [schema];
  const containerName = `pun85-sql-${suffix}`;
  let connectionString = process.env.PUN85_TEST_DATABASE_URL;
  let directory: string | undefined;
  let containerOwned = false;
  let writer: pg.Client | undefined;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (writer) {
        try {
          for (const ownedSchema of [...schemas].reverse()) {
            await writer.query(`DROP SCHEMA IF EXISTS ${quote(ownedSchema)} CASCADE`);
          }
        } finally {
          await writer.end();
        }
      }
    } finally {
      try {
        if (containerOwned) await docker(["rm", "--force", containerName]);
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }

  try {
    if (connectionString === undefined) {
      try {
        const context = await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
        if (!context.stdout.trim().startsWith("unix://")) {
          throw new Error("SQL fixtures require a local Docker Unix-socket engine");
        }
        await docker(["image", "inspect", image]);
      } catch (error) {
        throw new Error(`SQL connector integration requires a local Docker engine with cached ${image}, or an explicit disposable PUN85_TEST_DATABASE_URL. The test never pulls images or uses DATABASE_URL.`, { cause: error });
      }
      directory = await mkdtemp(join(tmpdir(), "pun85-sql-"));
      const socket = join(directory, "socket");
      await mkdir(socket);
      await chmod(socket, 0o777);
      const database = `pun85_sql_${suffix}`;
      const url = new URL(`postgresql://postgres@localhost/${database}`);
      url.searchParams.set("host", socket);
      url.searchParams.set("port", "5432");
      connectionString = url.toString();
      containerOwned = true;
      await docker([
        "run", "--detach", "--pull=never", "--network=none",
        "--name", containerName, "--tmpfs", "/var/lib/postgresql/data:rw",
        "--mount", `type=bind,src=${socket},dst=/var/run/postgresql/pun85`,
        "--env", "POSTGRES_USER=postgres", "--env", `POSTGRES_DB=${database}`,
        "--env", "POSTGRES_HOST_AUTH_METHOD=trust", image,
        "-c", "listen_addresses=", "-c",
        "unix_socket_directories=/var/run/postgresql,/var/run/postgresql/pun85",
      ]);
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      do {
        const serverProcess = await docker(["exec", containerName, "cat", "/proc/1/comm"]);
        if (serverProcess.stdout.trim() !== "postgres") {
          await delay(100);
          continue;
        }
        const candidate = localConnection(connectionString);
        try {
          await candidate.connect();
          writer = candidate;
          break;
        } catch (error) {
          lastError = error;
          await candidate.end().catch(() => undefined);
          await delay(100);
        }
      } while (Date.now() < deadline);
      if (!writer) {
        const logs = await docker(["logs", "--tail", "15", containerName]).catch(() => undefined);
        throw new Error(`Disposable SQL fixture did not become ready within 30 seconds. ${logs ? logs.stdout + logs.stderr : "Container logs unavailable."}`, { cause: lastError });
      }
    } else {
      writer = localConnection(connectionString);
      await writer.connect();
    }
    await writer.query("SET TIME ZONE 'UTC'");
    await writer.query("SET DateStyle = ISO");
    await writer.query(`CREATE SCHEMA ${quote(schema)}`);
    return {
      connectionString,
      writer,
      schema,
      table: (name, tableSchema = schema) => `${quote(tableSchema)}.${quote(name)}`,
      createSchema: async (extraSuffix) => {
        const extraSchema = `${schema}${extraSuffix}`;
        schemas.push(extraSchema);
        await writer!.query(`CREATE SCHEMA ${quote(extraSchema)}`);
        return extraSchema;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
