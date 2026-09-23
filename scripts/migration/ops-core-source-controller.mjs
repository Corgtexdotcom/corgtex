import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { openSourceOperations } from "./ops-core-source-operations.mjs";
import { assertPostgresSourceFenced, runPostgresSourceFence } from "./ops-core-postgres-fence.mjs";
import { RailwaySourceFence } from "./railway-source-fence.mjs";
import { createRailwayPostgresCustody } from "./railway-postgres-custody.mjs";

class ControllerError extends Error {
  constructor(code) { super(code); Object.freeze(this); }
}
const fail = code => { throw new ControllerError(code); };
const exact = (value, fields) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")) fail("SOURCE_CONTROLLER_PLAN_INVALID");
};
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && [...left].sort().join(",") === [...right].sort().join(",");

function context(options, runRecordedOperation) {
  const plan = structuredClone(options.plan);
  const { custody, railway = {} } = options;
  if (plan?.schemaVersion !== 1 || !["core", "ops"].includes(plan.domain)) fail("SOURCE_CONTROLLER_PLAN_INVALID");
  exact(plan.source, "writers,postgresTriggers,postgresService,postgres");
  exact(plan.source.writers, "binding,expectedSourceLinks");
  exact(plan.source.postgresTriggers, "binding,expectedSourceLinks");
  exact(plan.source.postgres, "expected,retainedSecretVersion,vaultName");
  const journal = custody.snapshot();
  if (journal.domain !== plan.domain || journal.intentSha256 !== archiveEvidenceHash(plan)) fail("SOURCE_CONTROLLER_INTENT_MISMATCH");
  const service = plan.source.postgresService;
  const writers = plan.source.writers.binding;
  const triggers = plan.source.postgresTriggers.binding;
  if (service.domain !== plan.domain || plan.source.postgres.expected.domain !== plan.domain
    || writers.projectId !== service.projectId || writers.environmentId !== service.environmentId
    || triggers.projectId !== service.projectId || triggers.environmentId !== service.environmentId
    || !sameIds(triggers.serviceIds, [service.serviceId]) || !Array.isArray(writers.serviceIds)
    || writers.serviceIds.includes(service.serviceId)
    || plan.source.postgres.expected.systemIdentifier !== service.systemIdentifier) fail("SOURCE_CONTROLLER_SERVICE_MISMATCH");
  const pgCustody = createRailwayPostgresCustody({ binding: service, signal: custody.signal,
    ...(railway.transport ? { transport: railway.transport } : { token: railway.token }),
    ...(railway.runRemoteRead ? { runRemoteRead: railway.runRemoteRead } : {}) });
  if (plan.source.postgres.expected.databaseServiceSha256 !== pgCustody.bindingSha256) fail("SOURCE_CONTROLLER_POSTGRES_BINDING_MISMATCH");
  const create = config => new RailwaySourceFence({ ...config, signal: custody.signal, runRecordedOperation,
    ...(railway.transport ? { transport: railway.transport } : { token: railway.token }) });
  const controls = {
    postgres: create(plan.source.postgresTriggers),
    writers: create(plan.source.writers),
  };
  const check = async () => {
    custody.signal.throwIfAborted();
    await custody.assertOwned();
    const current = custody.snapshot();
    if (current.domain !== plan.domain || current.intentSha256 !== archiveEvidenceHash(plan)) fail("SOURCE_CONTROLLER_INTENT_MISMATCH");
    custody.signal.throwIfAborted();
  };
  const assertDatabaseServiceCustody = async () => {
    await check();
    const receipt = await pgCustody.assertHeld();
    const policy = await controls.postgres.read();
    if (!policy.staged.empty || policy.services.some(item => item.autoDeployEnabled
      || item.configuredCronSchedule !== null || item.cronSchedule !== null || item.nextCronRunAt !== null
      || (item.sourceKind === "image" && item.autoUpdatesType !== "disabled"))) fail("SOURCE_CONTROLLER_POSTGRES_TRIGGERS_UNPROVEN");
    await check();
    return receipt;
  };
  const assertProviderFenced = async () => {
    await check();
    const receipt = await controls.writers.assertFenced();
    if (receipt.complete !== true) fail("SOURCE_CONTROLLER_WRITERS_UNPROVEN");
    await check();
    return receipt;
  };
  const postgresOptions = operations => ({ ...plan.source.postgres, custody, operations,
    sourceConfig: options.sourceConfig, readerConfig: options.readerConfig,
    ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
    assertDatabaseServiceCustody, assertProviderFenced });
  return { plan, controls, pgCustody, check, assertProviderFenced, assertDatabaseServiceCustody, postgresOptions };
}

function controlFor(ctx, descriptor) {
  const input = descriptor.input;
  const actual = input.binding ?? { projectId: input.projectId, environmentId: input.environmentId, serviceIds: [input.serviceId] };
  for (const name of ["postgres", "writers"]) {
    const expected = (name === "postgres" ? ctx.plan.source.postgresTriggers : ctx.plan.source.writers).binding;
    if (actual.projectId === expected.projectId && actual.environmentId === expected.environmentId
      && (input.binding ? sameIds(actual.serviceIds, expected.serviceIds) : expected.serviceIds.includes(input.serviceId))) return name;
  }
  fail("SOURCE_CONTROLLER_RECOVERY_BINDING_MISMATCH");
}

async function evidence(ctx, postgres) {
  return { schemaVersion: 1, domain: ctx.plan.domain, intentSha256: archiveEvidenceHash(ctx.plan),
    sourcePlanSha256: archiveEvidenceHash(ctx.plan.source), railway: await ctx.assertProviderFenced(),
    postgresService: await ctx.assertDatabaseServiceCustody(), postgres };
}

/** Drives the actual source phase using Railway adapters, remote PostgreSQL and
 * independent create-only operation records. Credentials are supplied separately
 * from the retained plan. A stopped application is never mistaken for a stopped
 * database; PostgreSQL stays available for capture and local operator recovery.
 */
export async function runOpsCoreSourceFence(options) {
  let operations;
  try {
    const ctx = context(options, operation => {
      if (!operations) fail("SOURCE_CONTROLLER_OPERATIONS_NOT_OPEN");
      return operations.runRecordedOperation(operation);
    });
    const { custody, operationStore } = options;
    await ctx.check();
    const current = custody.snapshot();
    if (current.phase !== "PREPARED") fail("SOURCE_CONTROLLER_PHASE_INVALID");
    const sourceIntent = archiveEvidenceHash(ctx.plan.source);
    if (current.pending && (current.pending.to !== "SOURCE_FENCED" || current.pending.intentSha256 !== sourceIntent)) fail("SOURCE_CONTROLLER_PENDING_MISMATCH");
    // Establish the password-free recovery channel before stopping any runtime.
    await ctx.pgCustody.assertHeld();
    await ctx.check();
    const pendingPhase = current.pending ?? await custody.begin("SOURCE_FENCED", sourceIntent);
    operations = await openSourceOperations({ custody, store: operationStore });
    await operations.retainPhaseArtifact("phase-plan", { schemaVersion: 1, domain: ctx.plan.domain,
      intentSha256: archiveEvidenceHash(ctx.plan), source: ctx.plan.source });
    const recorded = await operations.recordedDescriptors();
    const pending = recorded.filter(item => !item.completed);
    const railwayPending = pending.filter(item => item.kind.startsWith("RAILWAY_"));
    const resume = { postgres: {}, writers: {} };
    let stagedOwner = null;
    // A stage receipt can be durable even when the caller never received it.
    // Recover the current patch from all retained stages, including completed
    // ones, before deciding which service group may use shared staging next.
    const staged = (await ctx.controls.postgres.read()).staged;
    if (!staged.empty) {
      const matches = recorded.filter(item => item.kind === "RAILWAY_STAGE_SOURCE_TRIGGERS"
        && item.input.patchSha256 === staged.patchSha256);
      if (matches.length !== 1) fail("SOURCE_CONTROLLER_STAGING_OWNERSHIP_UNPROVEN");
      stagedOwner = controlFor(ctx, matches[0]);
      resume[stagedOwner].resumeStagedPatch = { environmentId: matches[0].input.binding.environmentId,
        patchSha256: matches[0].input.patchSha256 };
    }
    for (const descriptor of railwayPending) {
      const name = controlFor(ctx, descriptor);
      await ctx.controls[name].reconcileRecordedOperation({ ...descriptor, readIntent: operations.readIntent });
      if (descriptor.kind === "RAILWAY_STAGE_SOURCE_TRIGGERS") {
        if (stagedOwner && stagedOwner !== name) fail("SOURCE_CONTROLLER_MULTIPLE_STAGING_OWNERS");
        stagedOwner = name;
        resume[name].resumeStagedPatch = { environmentId: descriptor.input.binding.environmentId,
          patchSha256: descriptor.input.patchSha256 };
      } else if (descriptor.kind === "RAILWAY_COMMIT_SOURCE_TRIGGERS") {
        resume[name].resumeCommit = { environmentId: descriptor.input.binding.environmentId,
          patchSha256: descriptor.input.patchSha256, stagedPatchId: descriptor.input.stagedPatchId };
      }
    }
    // An owned staged patch must finish before the other service group's patch.
    const order = stagedOwner === "writers" ? ["writers", "postgres"] : ["postgres", "writers"];
    for (const name of order) {
      await ctx.check();
      await ctx.controls[name].disableTriggers({ ...resume[name], readIntent: operations.readIntent });
    }
    await ctx.controls.writers.stopWriters();
    await ctx.assertProviderFenced();
    await ctx.assertDatabaseServiceCustody();
    const postgres = await runPostgresSourceFence({ ...ctx.postgresOptions(operations),
      resumeSessionOperations: pending.filter(item => item.kind === "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION") });
    const settled = await operations.assertSettled();
    const result = { ...await evidence(ctx, postgres), operations: settled };
    const evidenceSha256 = await operations.retainPhaseArtifact("phase-evidence", result);
    await ctx.check();
    await custody.complete(pendingPhase.operationId, evidenceSha256);
    return { status: "SOURCE_FENCED", evidenceSha256, evidence: result };
  } catch (error) {
    throw error instanceof ControllerError ? error : new ControllerError("SOURCE_CONTROLLER_RECONCILIATION_REQUIRED");
  }
}

/** Recheck source fencing during capture/restore without any provider writes. */
export async function assertOpsCoreSourceFenced(options) {
  try {
    const ctx = context(options, async () => fail("SOURCE_CONTROLLER_READ_ONLY"));
    await ctx.check();
    const postgres = await assertPostgresSourceFenced(ctx.postgresOptions(undefined));
    const result = await evidence(ctx, postgres);
    await ctx.check();
    return result;
  } catch (error) {
    throw error instanceof ControllerError ? error : new ControllerError("SOURCE_CONTROLLER_RECONCILIATION_REQUIRED");
  }
}
