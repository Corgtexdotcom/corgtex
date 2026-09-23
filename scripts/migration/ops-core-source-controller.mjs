import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { openSourceOperations } from "./ops-core-source-operations.mjs";
import { assertPostgresSourceFenced, runPostgresSourceFence, preflightOpsCorePostgresSource, recoverPostgresSourcePassword } from "./ops-core-postgres-fence.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { sourceRecoveryAllowed } from "./ops-core-custody.mjs";
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
  exact(plan.source, "writers,postgresTriggers,postgresService,postgres,health");
  exact(plan.source.writers, "binding,expectedSourceLinks");
  exact(plan.source.postgresTriggers, "binding,expectedSourceLinks");
  exact(plan.source.postgres, "expected,retainedSecretVersion,originalSecretVersion,vaultName");
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
    if (options.assertTargetInactive) {
      const proof = await options.assertTargetInactive();
      if (proof?.complete !== true || proof.domain !== plan.domain || proof.intentSha256 !== archiveEvidenceHash(plan)
        || proof.targetBindingSha256 !== opsCoreAzureTargetBindingSha256(plan.azure)) fail("SOURCE_RECOVERY_TARGET_INACTIVITY_UNPROVEN");
      custody.signal.throwIfAborted();
      await custody.assertOwned();
    }
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
  const assertSourceHealthy = async (stage, baseline, writerBaseline) => {
    await check();
    if (!plan.source.health || typeof options.assertSourceHealthy !== "function") fail("SOURCE_CONTROLLER_HEALTH_REQUIRED");
    const result = await options.assertSourceHealthy({ stage, baseline, writerBaseline });
    if (result?.complete !== true || result.domain !== plan.domain || result.intentSha256 !== archiveEvidenceHash(plan)
      || result.sourceHealthBindingSha256 !== archiveEvidenceHash(plan.source.health)
      || !/^[a-f0-9]{64}$/.test(result.evidenceSha256)) fail("SOURCE_CONTROLLER_HEALTH_UNPROVEN");
    await check();
    return structuredClone(result);
  };
  const postgresOptions = operations => ({ ...plan.source.postgres, custody, operations,
    sourceConfig: options.sourceConfig, readerConfig: options.readerConfig,
    ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
    ...(options.resolveOriginalSecret ? { resolveOriginalSecret: options.resolveOriginalSecret } : {}),
    assertDatabaseServiceCustody, assertProviderFenced });
  return { plan, controls, pgCustody, check, assertProviderFenced, assertDatabaseServiceCustody, assertSourceHealthy, postgresOptions };
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
    let ctx;
    ctx = context(options, operation => {
      if (!operations) fail("SOURCE_CONTROLLER_OPERATIONS_NOT_OPEN");
      return operations.runRecordedOperation({ ...operation,
        apply: async () => { await ctx.check(); const value = await operation.apply(); await ctx.check(); return value; },
        verify: async () => { await ctx.check(); const value = await operation.verify(); await ctx.check(); return value; } });
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
    let phasePlan = await operations.readPhaseArtifact("phase-plan");
    if (phasePlan === null) {
      if ((await operations.recordedDescriptors()).length) fail("SOURCE_CONTROLLER_BASELINE_MISSING");
      const credential = await preflightOpsCorePostgresSource({ ...ctx.postgresOptions(undefined),
        assertDatabaseServiceCustody: () => ctx.pgCustody.assertHeld() });
      const baseline = { credential, postgres: await ctx.controls.postgres.captureRecoveryBaseline(),
        writers: await ctx.controls.writers.captureRecoveryBaseline() };
      baseline.health = await ctx.assertSourceHealthy("baseline", null, baseline.writers);
      phasePlan = { schemaVersion: 1, domain: ctx.plan.domain, intentSha256: archiveEvidenceHash(ctx.plan),
        source: ctx.plan.source, recoveryBaseline: baseline };
      await operations.retainPhaseArtifact("phase-plan", phasePlan);
    }
    if (!phasePlan.recoveryBaseline || archiveEvidenceHash(phasePlan.source) !== sourceIntent
      || phasePlan.intentSha256 !== archiveEvidenceHash(ctx.plan) || phasePlan.domain !== ctx.plan.domain) fail("SOURCE_CONTROLLER_BASELINE_MISSING");
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
      await ctx.controls[name].assertRecoveryBaseline(phasePlan.recoveryBaseline[name],
        { stagedPatchSha256: staged.empty ? null : staged.patchSha256 });
      await ctx.controls[name].disableTriggers({ ...resume[name], readIntent: operations.readIntent });
    }
    await ctx.controls.writers.assertRecoveryBaseline(phasePlan.recoveryBaseline.writers);
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


/** Restores the retained source only before the first possible target startup.
 * Every effect remains under the existing independent lease. An inherited
 * provider intent can only reconcile; the caller must reopen after ambiguity.
 * A completed recovery permanently closes this global cutover intent. */
export async function recoverOpsCoreSource(options) {
  try {
    if (!["apply", "reconcile"].includes(options.action) || typeof options.assertTargetInactive !== "function") {
      fail("SOURCE_RECOVERY_AUTHORITY_REQUIRED");
    }
    const { custody, operationStore } = options;
    let operations;
    let ctx;
    const guard = async () => {
      await ctx.check();
      const current = custody.snapshot();
      if (!sourceRecoveryAllowed(current) || current.pending?.to !== "SOURCE_RECOVERED") fail("SOURCE_RECOVERY_FORBIDDEN");
      await ctx.pgCustody.assertHeld();
    };
    ctx = context(options, operation => operations.runRecordedOperation({ ...operation,
      apply: async () => { await guard(); const value = await operation.apply(); await guard(); return value; },
      verify: async () => { await guard(); const value = await operation.verify(); await guard(); return value; } }));
    let journal = custody.snapshot();
    if (journal.phase === "SOURCE_RECOVERED") {
      await custody.assertOwned();
      await operationStore.assertPrivate();
      const entry = journal.history.at(-1);
      const key = `operations/${journal.domain}/${journal.intentSha256}/${entry.operationId}/phase-evidence-${entry.evidenceSha256}.json`;
      const text = await operationStore.readOptional(key, custody.signal);
      if (typeof text !== "string" || Buffer.byteLength(text) > 32 * 1024 * 1024) fail("SOURCE_RECOVERY_EVIDENCE_MISSING");
      const evidence = JSON.parse(text);
      if (archiveEvidenceHash(evidence) !== entry.evidenceSha256 || evidence.status !== "SOURCE_RECOVERED"
        || evidence.domain !== journal.domain || evidence.intentSha256 !== journal.intentSha256) fail("SOURCE_RECOVERY_EVIDENCE_MISMATCH");
      await custody.assertOwned();
      return { status: "SOURCE_RECOVERED", historical: true, freshAcceptance: false, evidenceSha256: entry.evidenceSha256, evidence };
    }
    await ctx.check();
    if (!sourceRecoveryAllowed(journal)) fail("SOURCE_RECOVERY_FORBIDDEN");
    // The existing fence reconciler settles owned stage/commit/stop/password
    // intents. It never redispatches an inherited ambiguous provider operation.
    if (journal.pending?.to === "SOURCE_FENCED") {
      if (options.action !== "apply") fail("SOURCE_RECOVERY_FENCE_SETTLEMENT_REQUIRED");
      await runOpsCoreSourceFence(options);
      journal = custody.snapshot();
    }
    const sourceHistory = journal.history.find(item => item.phase === "SOURCE_FENCED");
    if (!sourceHistory?.operationId || sourceHistory.intentSha256 !== archiveEvidenceHash(ctx.plan.source)) fail("SOURCE_RECOVERY_BASELINE_MISSING");
    const sourceSnapshot = { ...journal, phase: "PREPARED", pending: { from: "PREPARED", to: "SOURCE_FENCED",
      operationId: sourceHistory.operationId, intentSha256: sourceHistory.intentSha256 } };
    const originalOperations = await openSourceOperations({ custody: { signal: custody.signal,
      assertOwned: () => custody.assertOwned(), snapshot: () => structuredClone(sourceSnapshot) }, store: operationStore });
    const retained = await originalOperations.readPhaseArtifact("phase-plan");
    if (!retained?.recoveryBaseline || retained.domain !== ctx.plan.domain
      || retained.intentSha256 !== archiveEvidenceHash(ctx.plan)
      || archiveEvidenceHash(retained.source) !== archiveEvidenceHash(ctx.plan.source)) fail("SOURCE_RECOVERY_BASELINE_MISSING");
    await originalOperations.assertSettled();
    const baseline = retained.recoveryBaseline;
    if (baseline.credential?.originalSecretVersion !== ctx.plan.source.postgres.originalSecretVersion
      || baseline.credential?.retainedSecretVersion !== ctx.plan.source.postgres.retainedSecretVersion
      || baseline.credential?.complete !== true) fail("SOURCE_RECOVERY_CREDENTIAL_BASELINE_INVALID");
    if (baseline.health?.complete !== true || baseline.health.domain !== ctx.plan.domain
      || baseline.health.intentSha256 !== archiveEvidenceHash(ctx.plan)
      || baseline.health.sourceHealthBindingSha256 !== archiveEvidenceHash(ctx.plan.source.health)
      || !/^[a-f0-9]{64}$/.test(baseline.health.evidenceSha256)) fail("SOURCE_RECOVERY_HEALTH_BASELINE_INVALID");
    const recoveryPlan = { schemaVersion: 1, domain: ctx.plan.domain, intentSha256: archiveEvidenceHash(ctx.plan),
      sourceOperationId: sourceHistory.operationId, baselineSha256: archiveEvidenceHash(baseline) };
    const recoveryIntent = archiveEvidenceHash(recoveryPlan);
    if (!journal.recovery) {
      if (options.action !== "apply") fail("SOURCE_RECOVERY_NOT_STARTED");
      await ctx.assertProviderFenced();
      await ctx.assertDatabaseServiceCustody();
      await ctx.controls.postgres.assertRecoveryBaseline(baseline.postgres);
      await ctx.controls.writers.assertRecoveryBaseline(baseline.writers);
      await ctx.check();
      await custody.beginSourceRecovery(recoveryIntent);
    } else if (journal.pending?.to !== "SOURCE_RECOVERED" || journal.pending.intentSha256 !== recoveryIntent) {
      fail("SOURCE_RECOVERY_INTENT_MISMATCH");
    }
    const recoveryOperations = await openSourceOperations({ custody, store: operationStore });
    operations = { ...recoveryOperations, runRecordedOperation: async operation => {
      if (options.action === "reconcile" && !await recoveryOperations.readIntent(operation.kind, operation.input)) {
        fail("SOURCE_RECOVERY_EXPLICIT_CONTINUATION_REQUIRED");
      }
      return recoveryOperations.runRecordedOperation(operation);
    } };
    await operations.retainPhaseArtifact("phase-plan", recoveryPlan);
    const recorded = await operations.recordedDescriptors();
    // On reentry, the only permissible staged patch is one retained by this
    // recovery. PostgreSQL and writer groups share the environment staging slot.
    const staged = (await ctx.controls.postgres.read()).staged;
    const stages = recorded.filter(item => item.kind === "RAILWAY_STAGE_RECOVERY_TRIGGERS" && item.input.patchSha256 === staged.patchSha256);
    if (!staged.empty && stages.length !== 1) fail("SOURCE_RECOVERY_STAGING_UNPROVEN");
    const stagedHash = staged.empty ? null : staged.patchSha256;
    const baselineGuard = async () => {
      await guard();
      await ctx.controls.writers.assertRecoveryBaseline(baseline.writers, { stagedPatchSha256: stagedHash });
      await ctx.controls.postgres.assertRecoveryBaseline(baseline.postgres, { stagedPatchSha256: stagedHash });
    };
    // No triggers or runtime restart precede exact authentication proof.
    const postgres = await recoverPostgresSourcePassword({ ...ctx.postgresOptions(operations),
      assertProviderFenced: baselineGuard, assertDatabaseServiceCustody: guard });
    await ctx.controls.writers.restartBaselineWriters(baseline.writers, { stagedPatchSha256: stagedHash });
    const beforeTriggersHealth = await ctx.assertSourceHealthy("recovery", baseline.health, baseline.writers);
    const first = !staged.empty && controlFor(ctx, stages[0]) === "writers" ? "writers" : "postgres";
    for (const name of [first, first === "postgres" ? "writers" : "postgres"]) {
      await ctx.controls[name].restoreBaselineTriggers(baseline[name], { recorded, readIntent: operations.readIntent });
    }
    await guard();
    const finalHealth = await ctx.assertSourceHealthy("recovery", baseline.health, baseline.writers);
    const result = { schemaVersion: 1, status: "SOURCE_RECOVERED", domain: ctx.plan.domain,
      intentSha256: archiveEvidenceHash(ctx.plan), baselineSha256: archiveEvidenceHash(baseline), postgres,
      writers: await ctx.controls.writers.assertRecoveryBaseline(baseline.writers, { running: true, restored: true }),
      postgresService: await ctx.controls.postgres.assertRecoveryBaseline(baseline.postgres, { running: true, restored: true }),
      healthBeforeTriggers: beforeTriggersHealth,
      health: finalHealth,
      operations: await operations.assertSettled() };
    const evidenceSha256 = await operations.retainPhaseArtifact("phase-evidence", result);
    await guard();
    await custody.complete(custody.snapshot().pending.operationId, evidenceSha256);
    return { status: "SOURCE_RECOVERED", evidenceSha256, evidence: result };
  } catch (error) {
    throw error instanceof ControllerError ? error : new ControllerError("SOURCE_RECOVERY_RECONCILIATION_REQUIRED");
  }
}
