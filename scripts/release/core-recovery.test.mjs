import { describe, expect, it, vi } from "vitest";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { recoverCore } from "./core-recovery.mjs";

const sourceSha = "d0a3896ef917b50f2fec2d797908f29aa026a058";
const candidate = "6b9c848e3742007891e8bb859bb9f4b4cf30f293";
const failed = "7c566687-39c3-44d1-a481-3882c12e991f";
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const releaseSettings = sha => ({ CORGTEX_RELEASE_VERSION: `main-${sha.slice(0, 12)}`,
  CORGTEX_RELEASE_IMAGE_TAG: `sha-${sha}`, CORGTEX_RELEASE_GIT_SHA: sha, CORGTEX_STARTUP_MODE: "web" });
const image = (role, sha) => `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${sha}`;

function fixture() {
  const target = { id: "backup-app", origin: "https://app.corgtex.com", provider: "railway", projectId: uuid(1),
    environmentId: uuid(2), webServiceId: uuid(3), workerServiceId: uuid(4), databaseIdentitySha256: "a".repeat(64) };
  const images = { web: { deploymentId: uuid(5), digest: `sha256:${"b".repeat(64)}` },
    worker: { deploymentId: uuid(6), digest: `sha256:${"c".repeat(64)}` } };
  const verifierSha = "a".repeat(40);
  const evidence = { target, sourceSha, images,
    buildProof: { kind: "direct-container-build-readback", evidenceSha256: "d".repeat(64), observedAt: "2026-09-15T00:00:00Z",
      roles: Object.fromEntries(["web", "worker"].map(role => [role, { deploymentId: images[role].deploymentId, sourceSha }])) },
    authProof: { kind: "protected-review-retained-core-auth", runId: 1, runAttempt: 1, jobId: 2, stepNumber: 3,
      workflowSha: verifierSha, evidenceSha256: "e".repeat(64), observedAt: "2026-09-15T00:00:00Z", origin: target.origin,
      checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true } } };
  const receipt = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence,
    schema: { manifestSha256: "f".repeat(64), datamodelSha256: "f".repeat(64), exactLedgerMatch: true, supportedSchemaMatch: true },
    acceptance: { repository: "Corgtexdotcom/corgtex", workflowPath: ".github/workflows/accepted-core-baseline.yml",
      workflowSha: verifierSha, runId: 4, runAttempt: 1, acceptedAt: "2026-09-15T00:00:00Z", evidenceSha256: identityHash(evidence) } };
  const receiptBytes = JSON.stringify(receipt);
  const pin = { schemaVersion: 1, target: "backup-app", targetSha256: identityHash(target), sourceSha,
    verifierSha, receiptSha256: sha256(receiptBytes), run: { id: 4, attempt: 1, workflowId: 5, workflowSha: verifierSha },
    artifact: { id: 6, name: "accepted-core-baseline-4-1", sha256: "b".repeat(64) } };
  const request = { schemaVersion: 1, failedRunId: 36757068293, failedCandidateSha: candidate,
    failedWebDeploymentId: failed, acceptedReceiptSha256: pin.receiptSha256, releaseSettings: releaseSettings(sourceSha) };
  const stages = {};
  for (const role of ["web", "worker"]) {
    const serviceId = target[`${role}ServiceId`];
    const anchor = role === "web" ? { id: failed, status: "CRASHED" } : { id: images.worker.deploymentId, status: "SUCCESS" };
    stages[serviceId] = { instance: { source: { image: image(role, candidate), repo: null },
      startCommand: `npm run start --workspace=@corgtex/${role}`, preDeployCommand: null,
      latestDeployment: anchor, activeDeployments: [anchor] },
      environment: { id: target.environmentId, projectId: target.projectId, config: { services: {
        [serviceId]: { source: { image: image(role, candidate) }, deploy: { registryCredentials: { username: "***", password: "***" } } },
      } } }, variables: { ...releaseSettings(candidate), UNRELATED_SECRET: "private-fixture-never-return" },
      deployments: { edges: [{ node: { ...anchor, meta: { imageDigest: role === "web" ? `sha256:${"d".repeat(64)}` : images.worker.digest } } },
        ...(role === "web" ? [{ node: { id: images.web.deploymentId, status: "REMOVED", meta: { imageDigest: images.web.digest } } }] : [])], pageInfo: { hasNextPage: false } },
      pending: { edges: [], pageInfo: { hasNextPage: false } } };
  }
  const writes = [];
  const events = [];
  let reserved = false;
  const deps = {
    reserveDeployment: vi.fn(async intent => { if (reserved) throw new Error("DEPLOYMENT_ALREADY_RESERVED"); reserved = true; return { reserved: true, intent }; }),
    assertContext: vi.fn(async () => { events.push("context"); }),
    verifyDatabase: vi.fn(async () => { events.push("database"); return structuredClone(receipt.schema); }),
    verifyRegistry: vi.fn(async () => { events.push("registry"); }),
    verifyRuntime: vi.fn(async runtime => { events.push("runtime"); expect(runtime.images.worker).toEqual(images.worker); }),
    graphql: vi.fn(async (query, variables) => {
      if (query.startsWith("query")) return structuredClone(stages[variables.serviceId]);
      writes.push({ query, variables: structuredClone(variables) });
      const stage = stages[variables.serviceId];
      if (query.includes("variableCollectionUpsert")) Object.assign(stage.variables, variables.variables);
      if (query.includes("serviceInstanceUpdate")) {
        stage.instance.source.image = variables.input.source.image;
        stage.environment.config.services[variables.serviceId].source.image = variables.input.source.image;
      }
      return query.includes("serviceInstanceDeployV2") ? { deploymentId: uuid(7) } : { ok: true };
    }),
  };
  return { request, receipt, receiptBytes, pin, target, stages, writes, deps, events };
}

describe("incident-bound Core recovery", () => {
  it("admits the observed zero-serving-web incident for a read-only plan, preserving private provider fields", async () => {
    const f = fixture();
    const result = await recoverCore(f, f.deps);
    expect(result).toMatchObject({ dryRun: true, mutations: 0, deployRoles: ["web"] });
    expect(f.writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-fixture");
    expect(f.events).toEqual(["context", "database", "registry"]);
  });

  it("restores variables without deployment, patches only images and deploys only web", async () => {
    const f = fixture();
    const original = JSON.stringify(f.receipt);
    const result = await recoverCore({ ...f, dryRun: false }, f.deps);
    expect(result.writes).toEqual(["variables:web", "variables:worker", "image:web", "image:worker", "deploy:web"]);
    expect(f.writes.filter(({ query }) => query.includes("variableCollectionUpsert")).every(({ query }) => query.includes("replace: false, skipDeploys: true"))).toBe(true);
    expect(f.writes.filter(({ query }) => query.includes("serviceInstanceUpdate")).map(({ variables }) => Object.keys(variables.input))).toEqual([["source"], ["source"]]);
    expect(f.writes.filter(({ query }) => query.includes("serviceInstanceDeployV2")).map(({ variables }) => variables.serviceId)).toEqual([f.target.webServiceId]);
    expect(f.stages[f.target.workerServiceId].instance.latestDeployment.id).toBe(f.receipt.evidence.images.worker.deploymentId);
    expect(f.stages[f.target.workerServiceId].variables.UNRELATED_SECRET).toBe("private-fixture-never-return");
    expect(f.deps.verifyDatabase).toHaveBeenCalledTimes(2);
    expect(result.baselineAdoptionRequired).toBe(true);
    expect(JSON.stringify(f.receipt)).toBe(original);
  });

  it.each(["pending", "worker", "digest", "image", "settings", "target", "command"])("blocks %s drift before the first mutation", async kind => {
    const f = fixture(); const web = f.stages[f.target.webServiceId];
    if (kind === "pending") web.pending.edges.push({ node: { id: uuid(8), status: "BUILDING" } });
    if (kind === "worker") f.stages[f.target.workerServiceId].instance.latestDeployment.id = uuid(8);
    if (kind === "digest") web.deployments.edges[1].node.meta.imageDigest = `sha256:${"e".repeat(64)}`;
    if (kind === "image") web.instance.source.image = web.environment.config.services[f.target.webServiceId].source.image = image("web", "e".repeat(40));
    if (kind === "settings") web.variables.CORGTEX_RELEASE_GIT_SHA = "e".repeat(40);
    if (kind === "target") web.environment.projectId = uuid(8);
    if (kind === "command") web.instance.preDeployCommand = "prisma migrate deploy";
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow(/CORE_RECOVERY_/);
    expect(f.writes).toEqual([]);
  });

  it.each(["assertContext", "verifyDatabase", "verifyRegistry"])("does not mutate when %s refuses acceptance", async gate => {
    const f = fixture(); f.deps[gate] = async () => { throw new Error("GATE_BLOCKED"); };
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow("GATE_BLOCKED");
    expect(f.writes).toEqual([]);
  });

  it("reconciles an interrupted variable/image staging without redeploying the worker", async () => {
    const f = fixture(); const web = f.stages[f.target.webServiceId];
    Object.assign(web.variables, f.request.releaseSettings);
    web.instance.source.image = web.environment.config.services[f.target.webServiceId].source.image = `ghcr.io/corgtexdotcom/corgtex/web@${f.receipt.evidence.images.web.digest}`;
    const result = await recoverCore({ ...f, dryRun: false }, f.deps);
    expect(result.writes).toEqual(["variables:worker", "image:worker", "deploy:web"]);
  });

  it("stops after a provider staging update unexpectedly changes the worker deployment", async () => {
    const f = fixture(); const graphql = f.deps.graphql;
    f.deps.graphql = async (query, variables) => {
      const result = await graphql(query, variables);
      if (query.includes("variableCollectionUpsert")) f.stages[f.target.workerServiceId].instance.latestDeployment.id = uuid(8);
      return result;
    };
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow("VARIABLE_READBACK");
    expect(f.writes).toHaveLength(1);
  });

  it("rejects modified receipt contents even when their internal evidence hash is recomputed", async () => {
    const f = fixture();
    f.receipt.evidence.images.web.digest = `sha256:${"e".repeat(64)}`;
    f.receipt.acceptance.evidenceSha256 = identityHash(f.receipt.evidence);
    await expect(recoverCore({ ...f, receiptBytes: JSON.stringify(f.receipt), dryRun: false }, f.deps)).rejects.toThrow("RECEIPT_BYTES");
    expect(f.writes).toEqual([]);
  });

  it("refuses deployment without a durable incident reservation", async () => {
    const f = fixture(); f.deps.reserveDeployment = async () => ({ reserved: false });
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow("DEPLOYMENT_INTENT_REQUIRED");
    expect(f.writes.filter(({ query }) => query.includes("serviceInstanceDeployV2"))).toHaveLength(0);
  });

  it("never repeats a deployment request whose outcome is unknown", async () => {
    const f = fixture(); const graphql = f.deps.graphql;
    f.deps.graphql = async (query, variables) => query.includes("serviceInstanceDeployV2")
      ? (f.writes.push({ query, variables }), {}) : graphql(query, variables);
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow("DEPLOYMENT_RESULT_UNCERTAIN");
    expect(f.writes.filter(({ query }) => query.includes("serviceInstanceDeployV2"))).toHaveLength(1);
    expect(f.deps.verifyRuntime).not.toHaveBeenCalled();
    // Provider observation can lag after the lost response. A new engine
    // invocation must honor the durable reservation rather than resubmit.
    await expect(recoverCore({ ...f, dryRun: false }, f.deps)).rejects.toThrow("DEPLOYMENT_ALREADY_RESERVED");
    expect(f.writes.filter(({ query }) => query.includes("serviceInstanceDeployV2"))).toHaveLength(1);
  });
});
