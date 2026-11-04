import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofInputs, healthyRole, schemaManifest, verifyIdentity } from "./image-startup-proof.mjs";

const sourceSha = "a".repeat(40), schemaSha = "b".repeat(40);
const input = { IMAGE_PROOF_SOURCE_SHA: sourceSha, IMAGE_PROOF_SCHEMA_SHA: schemaSha,
  IMAGE_PROOF_WEB_DIGEST: `sha256:${"c".repeat(64)}`, IMAGE_PROOF_WORKER_DIGEST: `sha256:${"d".repeat(64)}` };
const release = { runtime: { gitSha: sourceSha, evidence: "baked" }, configured: { gitSha: sourceSha },
  drift: { gitSha: false, imageTag: false, version: false } };
const web = { status: "ok", database: "up", schema: "ready", release };
const now = Date.now();
const worker = { status: "ok", phase: "running", tickCount: 1, lastSuccessfulTickAt: new Date(now - 500).toISOString(), lastError: null, release };
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("immutable image proof authority and readiness", () => {
  it("constructs only the fixed Corgtex immutable repositories and pinned PG16", () => {
    expect(proofInputs(input).images).toMatchObject({ web: `ghcr.io/corgtexdotcom/corgtex/web@${input.IMAGE_PROOF_WEB_DIGEST}`,
      worker: `ghcr.io/corgtexdotcom/corgtex/worker@${input.IMAGE_PROOF_WORKER_DIGEST}` });
    expect(proofInputs(input).images.db).toMatch(/^pgvector\/pgvector@sha256:[a-f0-9]{64}$/);
    expect(() => proofInputs({ ...input, IMAGE_PROOF_WEB_DIGEST: "latest" })).toThrow("IMAGE_PROOF_DIGEST_REQUIRED");
    expect(() => proofInputs({ ...input, IMAGE_PROOF_SOURCE_SHA: "main" })).toThrow("IMAGE_PROOF_SHA_REQUIRED");
  });
  it.each(["DATABASE_URL", "PRODUCTION_DATABASE_URL", "SELFSERVE_SCHEMA_AUDITOR_URL", "CONTROL_PLANE_AGENT_API_KEY", "SELFSERVE_VALIDATION_PASSWORD"])("rejects injected production credential %s", (key) => {
    expect(() => proofInputs({ ...input, [key]: "synthetic-forbidden" })).toThrow("IMAGE_PROOF_PRODUCTION_CREDENTIALS_FORBIDDEN");
  });
  it("requires baked role/source and byte-exact candidate schema", () => {
    const schema = { schemaSha256: "fixture", migrations: [{ name: "migration1", checksum: "sql" }] };
    const evidence = { identity: { schemaVersion: 1, role: "web", gitSha: sourceSha }, schema };
    expect(() => verifyIdentity(evidence, "web", sourceSha, schema)).not.toThrow();
    expect(() => verifyIdentity(evidence, "worker", sourceSha, schema)).toThrow("IMAGE_PROOF_BAKED_IDENTITY_MISMATCH");
    expect(() => verifyIdentity(evidence, "web", schemaSha, schema)).toThrow("IMAGE_PROOF_BAKED_IDENTITY_MISMATCH");
    expect(() => verifyIdentity(evidence, "web", sourceSha, { ...schema, migrations: [] })).toThrow("IMAGE_PROOF_CANDIDATE_SCHEMA_MISMATCH");
  });
  it("rejects healthy HTTP status with unready schema, spoofed identity or drift", () => {
    expect(healthyRole(web, "web", sourceSha, now)).toBe(true);
    expect(healthyRole({ ...web, schema: "stale" }, "web", sourceSha, now)).toBe(false);
    expect(healthyRole({ ...web, release: { ...release, runtime: { gitSha: sourceSha, evidence: "legacy_provider" } } }, "web", sourceSha, now)).toBe(false);
    expect(healthyRole({ ...web, release: { ...release, drift: { ...release.drift, gitSha: true } } }, "web", sourceSha, now)).toBe(false);
  });
  it("requires an actual recent successful worker cycle rather than HTTP200 starting", () => {
    expect(healthyRole(worker, "worker", sourceSha, now)).toBe(true);
    for (const changed of [{ phase: "starting" }, { tickCount: 0 }, { lastSuccessfulTickAt: null },
      { lastSuccessfulTickAt: new Date(now - 61_000).toISOString() }, { lastSuccessfulTickAt: new Date(now + 5000).toISOString() }, { lastError: "fixture failure" }]) {
      expect(healthyRole({ ...worker, ...changed }, "worker", sourceSha, now)).toBe(false);
    }
  });
  it("hashes SQL and Prisma bytes in canonical migration order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corgtex-schema-proof-test-")); directories.push(dir);
    await mkdir(join(dir, "migrations/002"), { recursive: true });
    await mkdir(join(dir, "migrations/001"), { recursive: true });
    await writeFile(join(dir, "schema.prisma"), "synthetic-schema");
    await writeFile(join(dir, "migrations/002/migration.sql"), "second");
    await writeFile(join(dir, "migrations/001/migration.sql"), "first");
    const before = await schemaManifest(dir);
    expect(before.migrations.map((entry) => entry.name)).toEqual(["001", "002"]);
    await writeFile(join(dir, "migrations/001/migration.sql"), "changed");
    expect((await schemaManifest(dir)).migrations[0].checksum).not.toBe(before.migrations[0].checksum);
  });
  it("keeps proof workflow separate from build and runtime secrets", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/release-images.yml", import.meta.url), "utf8");
    const proof = workflow.split("  startup-proof:")[1];
    expect(workflow).toContain("if: inputs.mode != 'proof'");
    expect(proof).toContain("environment: fleet-release-production");
    expect(proof).toContain("packages: read");
    expect(proof).not.toContain("secrets.");
    expect(proof).not.toMatch(/azure\/login|build-push-action|prisma:push/);
    expect(proof.split("Boot both normal entrypoints")[1]).not.toContain("IMAGE_PROOF_READ_TOKEN");
  });
});
