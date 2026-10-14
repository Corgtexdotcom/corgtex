import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { LOCAL_IMAGE, PG_IMAGES, pg18RehearsalImage } from "../ci-pgvector-image.mjs";

// Only fresh containers and runner-generated loopback URLs are consumed. Never
// use DATABASE_URL or externally supplied NOT NULL fixture URLs as test targets.
const ownedContainers = [];
const directory = mkdtempSync(resolve(tmpdir(), "corgtex-notnull-schema-"));
let child;
let interrupted;
function interrupt(signal) {
  interrupted = signal;
  child?.kill(signal);
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

async function run(program, args, { env = process.env, capture = false } = {}) {
  if (interrupted) throw new Error(`Fixture run interrupted: ${interrupted}`);
  return new Promise((done, fail) => {
    child = spawn(program, args, { env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", (bytes) => { output += bytes; });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) done(output.trim());
      else fail(new Error(`${program} failed (${signal ?? code})`));
    });
  });
}

async function fixture(major, schemaSql) {
  const database = `pg_notnull_${major}_test`;
  const name = `corgtex-notnull-pg${major}-${randomUUID()}`;
  const verifiedSource = process.env.CI_PGVECTOR_PG18_CONFIG_ID;
  const image = verifiedSource === undefined
    ? `pgvector/pgvector:pg${major}@${PG_IMAGES[major].index}`
    : major === 18 ? pg18RehearsalImage(verifiedSource).image : LOCAL_IMAGE;
  // Record the unique name before creation so a lost acknowledgement still
  // leaves enough information to remove this invocation's container.
  ownedContainers.push(name);
  await run("docker", ["run", "--detach", "--name", name,
    verifiedSource === undefined ? "--pull=missing" : "--pull=never",
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD=synthetic-test",
    "--env", "POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C --locale-provider=libc",
    "--env", `POSTGRES_DB=${database}`, image], { capture: true });
  const binding = await run("docker", ["port", name, "5432"], { capture: true });
  const port = binding.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Isolated loopback database binding required");
  const url = `postgresql://postgres:synthetic-test@127.0.0.1:${port}/${database}`;
  for (let attempt = 0; ; attempt++) {
    if (interrupted) throw new Error(`Fixture run interrupted: ${interrupted}`);
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      const { rows: [identity] } = await client.query("SELECT current_database() AS database, current_setting('server_version_num') AS version");
      if (identity.database !== database || !identity.version.startsWith(String(major))) {
        throw new Error("Fixture database identity mismatch");
      }
      break;
    } catch (error) {
      if (attempt === 60) throw error;
      await delay(200);
    } finally {
      await client.end();
    }
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(schemaSql);
    await client.query('CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY)');
  } finally {
    await client.end();
  }
  console.log(`Prepared isolated PostgreSQL ${major} database ${database}`);
  return url;
}

try {
  // Fail before starting either fixture if the verified CI source ID is invalid.
  pg18RehearsalImage(process.env.CI_PGVECTOR_PG18_CONFIG_ID);
  // Export/import require every Prisma model table. Generate them locally,
  // without applying migration history or seeding any application data. The
  // unsupported vector field is absent from Prisma's model metadata and is
  // unrelated to these NOT NULL cases. Exclude it and the vector extension:
  // the pinned engine images intentionally carry different vector versions.
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const fixtureSchema = schema.replace(/^\s*extensions = \[vector\]\r?\n/m, "")
    .replace(/^\s*vectorEmbedding Unsupported\("vector\(1536\)"\)\?\r?\n/m, "");
  if (fixtureSchema.includes('Unsupported("vector(') || fixtureSchema.includes("extensions = [vector]")) {
    throw new Error("Unexpected vector fixture schema");
  }
  const schemaPath = resolve(directory, "schema.prisma");
  writeFileSync(schemaPath, fixtureSchema);
  const schemaSql = await run(process.execPath, [resolve("node_modules/prisma/build/index.js"),
    "migrate", "diff", "--from-empty", "--to-schema-datamodel", schemaPath, "--script"], {
    capture: true,
    env: { ...process.env, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/unused" },
  });
  const source = await fixture(18, schemaSql);
  const target = await fixture(16, schemaSql);
  await run(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "--test",
    ...process.argv.slice(2), "scripts/migration/pg18-pg16-notnull.integration.test.ts"], {
    env: { ...process.env, PG18_NOTNULL_TEST_SOURCE_URL: source, PG18_NOTNULL_TEST_TARGET_URL: target },
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
} finally {
  for (const name of ownedContainers.reverse()) {
    try {
      execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      console.log(`Removed isolated fixture ${name}`);
    } catch (error) {
      if (!error.stderr?.toString().includes("No such container")) {
        console.error(`Failed to remove owned fixture ${name}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  rmSync(directory, { recursive: true, force: true });
}
