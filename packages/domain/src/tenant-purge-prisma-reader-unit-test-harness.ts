import { expect, it } from "vitest";
type UnitEvidence = Readonly<{
  calls: readonly string[];
  outcome: unknown;
  accesses: readonly string[];
  fired: string | null;
}>;
type UnitScenario = Readonly<{
  id: string;
  name: string;
  variant: string | null;
  fixture: Readonly<Record<string, unknown>>;
  expected: UnitEvidence;
  access(path: string): void;
  fire(point: string): void;
  observed(): Readonly<{ accesses: readonly string[]; fired: string | null }>;
}>;
type UnitProbe = (scenario: UnitScenario) => UnitEvidence | Promise<UnitEvidence>;
type UnitAdapterFactoryProbeLoader = () => UnitProbe | Promise<UnitProbe>; type Case = readonly [id: string, name: string];
const FREEZE = Object.freeze;
const DESCRIPTOR = Object.getOwnPropertyDescriptor;
const CREATE = Object.create; const STRING = String; const PROXY = Proxy;
const IDS = FREEZE({ runId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222", deploymentId: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444", trialId: "55555555-5555-4555-8555-555555555555" });
const KEY = FREEZE(Array.from({ length: 32 }, (_value, index) => index));
const CASES = FREEZE([
  ["AUTH-01", "unauthorized targetMode remains unobserved"],
  ["AUTH-02", "unauthorized runId remains unobserved"],
  ["AUTH-03", "unauthorized redactionKeyBytes remains unobserved"],
  ["AUTH-04", "unauthorized pageSize remains unobserved"],
  ["AUTH-05", "unauthorized maxPagesPerModel remains unobserved"],
  ["AUTH-06", "unauthorized maxEvidenceItems remains unobserved"],
  ["AUTH-07", "unauthorized cacheMaxTtlSeconds remains unobserved"],
  ["AUTH-08", "unauthorized construction never resolves shared Prisma or any Prisma property"],
  ["FACTORY-01", "denial callback is frozen, zero-argument, inert, and returns literal false"],
  ["FACTORY-02", "authorized callback is frozen and zero-argument"],
  ["FACTORY-03", "target mode accepts only the two exact released mode literals"],
  ["FACTORY-04", "run ID accepts only one canonical lowercase UUID"],
  ["FACTORY-05", "forged raw object, array, Uint8Array, Date, and Proxy keys are rejected"],
  ["FACTORY-06", "owned key rejects fewer than 32 and more than 64 bytes"],
  ["FACTORY-07", "owned key rejects every non-safe-integer and out-of-byte value"],
  ["FACTORY-08", "pageSize enforces exact integer bounds 1 through 1000"],
  ["FACTORY-09", "maxPagesPerModel enforces exact integer bounds 1 through 1000"],
  ["FACTORY-10", "maxEvidenceItems enforces exact integer bounds 1 through 100000"],
  ["FACTORY-11", "cacheMaxTtlSeconds enforces exact integer bounds 0 through 31536000"],
  ["INGRESS-01", "copied owned key is unchanged after caller-side mutation attempts"],
  ["INGRESS-02", "copied owned key is unchanged after the caller proxy is revoked"],
  ["INGRESS-03", "copied owned key survives poisoned globals and prototypes without caller execution"],
  ["ONESHOT-01", "replay after a settled first invocation fails closed without a second query"],
  ["ONESHOT-02", "a second invocation while the first transaction is pending fails closed without a second query"],
  ["QUERY-01", "exactly one interactive transaction uses RepeatableRead, maxWait 5000, and timeout 15000"],
  ["QUERY-02", "tenantPurgeRun.findUnique is the first and only authority read with exact where and select"],
  ["QUERY-03", "workspace.findUnique uses exact target ID, select, and no extra argument"],
  ["QUERY-04", "customerDeployment.findUnique uses exact target ID and exact topology and lease select"],
  ["QUERY-05", "workspace customerDeployment.findMany uses exact where, ID select, ID-ascending order, and take 1001"],
  ["QUERY-06", "workspace procurementTrial.findMany uses exact where, ID select, ID-ascending order, and take 1001"],
  ["QUERY-07", "customerAccount.findUnique uses the exact account lookup ID and exact select"],
  ["QUERY-08", "account customerDeployment.findMany uses exact where, ID select, ID-ascending order, and take 1001"],
  ["QUERY-09", "primary customerAccount.findMany uses exact deployment where, ID select, ID-ascending order, and take 1001"],
  ["QUERY-10", "procurementTrial.findUnique uses exact trial ID and exact select"],
  ["QUERY-11", "providerCutover.findFirst uses the exact account-or-deployment relation, ID select, and ID-ascending order"],
  ["QUERY-12", "clientMigrationRun.findFirst uses the exact account-or-deployment relation, ID select, and ID-ascending order"],
  ["QUERY-13", "account mode performs the exact complete delegate sequence with no trial target read"],
  ["QUERY-14", "trial mode performs the exact complete delegate sequence with no account target read"],
  ["DENY-01", "missing run returns literal false"],
  ["DENY-02", "every non-PLANNED status returns literal false"],
  ["DENY-03", "null or inactive activeTargetKey returns literal false"],
  ["DENY-04", "row mode different from the copied mode returns literal false"],
  ["DENY-05", "account mode rejects null account, non-null trial, and any wrong target shape"],
  ["DENY-06", "trial mode rejects null trial, non-null account, and any wrong target shape"],
  ["DENY-07", "canonicalTargetKey mismatch returns literal false"],
  ["DENY-08", "activeTargetKey mismatch returns literal false"],
  ["DENY-09", "malformed capability SHA fails closed"],
  ["DENY-10", "every DENY row records the authority read and no topology delegate access"],
  ["TOPO-01", "clean account topology returns the exact immutable account target and empty blockers"],
  ["TOPO-02", "clean self-serve trial topology returns the exact immutable trial target and expected expiry state"],
  ["TOPO-03", "missing workspace is preserved and yields TARGET_TUPLE_MISMATCH"],
  ["TOPO-04", "missing deployment is preserved and yields TARGET_TUPLE_MISMATCH"],
  ["TOPO-05", "missing account is preserved and yields TARGET_TUPLE_MISMATCH"],
  ["TOPO-06", "missing trial is preserved and yields TARGET_TUPLE_MISMATCH"],
  ["TOPO-07", "mismatched deployment-to-workspace link is preserved as shared ambiguity"],
  ["TOPO-08", "mismatched deployment-to-account link is preserved as shared ambiguity"],
  ["TOPO-09", "mismatched trial-to-workspace link is preserved and blocks the target tuple"],
  ["TOPO-10", "a sibling workspace deployment yields LINKED_DEPLOYMENT then SIBLING_DEPLOYMENT"],
  ["TOPO-11", "a sibling account deployment yields LINKED_DEPLOYMENT then SIBLING_DEPLOYMENT"],
  ["TOPO-12", "a sibling workspace trial yields the mode-correct LINKED_TRIAL blocker"],
  ["TOPO-13", "account.primaryDeploymentId conflict yields PRIMARY_ROUTING in released order"],
  ["TOPO-14", "another account naming the target deployment primary yields PRIMARY_ROUTING in released order"],
  ["TOPO-15", "every non-null managed-release lease field yields MANAGED_RELEASE_LEASE"],
  ["TOPO-16", "any related provider cutover row blocks regardless of status"],
  ["TOPO-17", "any related client migration row blocks regardless of status"],
  ["TOPO-18", "trial expiry before capturedAt is expired"],
  ["TOPO-19", "trial expiry exactly equal to capturedAt is expired"],
  ["TOPO-20", "trial expiry after capturedAt yields TRIAL_NOT_EXPIRED"],
  ["TOPO-21", "combined account blockers preserve the exact released blocker order"],
  ["TOPO-22", "combined trial blockers preserve the exact released blocker order"],
  ["BOUND-01", "duplicate workspace deployment ID fails closed"],
  ["BOUND-02", "duplicate workspace trial ID fails closed"],
  ["BOUND-03", "duplicate account deployment ID fails closed"],
  ["BOUND-04", "duplicate primary-account ID fails closed"],
  ["BOUND-05", "1001 workspace deployments fail before owned allocation"],
  ["BOUND-06", "1001 workspace trials fail before owned allocation"],
  ["BOUND-07", "1001 account deployments fail before owned allocation"],
  ["BOUND-08", "1001 primary accounts fail before owned allocation"],
  ["ROW-01", "malformed run account, deployment, workspace, or trial UUID fails closed"],
  ["ROW-02", "malformed workspace row or workspace ID fails closed"],
  ["ROW-03", "malformed deployment row, relation ID, or lease-field representation fails closed"],
  ["ROW-04", "malformed account row, account ID, or primaryDeploymentId fails closed"],
  ["ROW-05", "malformed trial row, trial ID, workspaceId, or trialExpiresAt fails closed"],
  ["ROW-06", "malformed provider-cutover row or ID fails closed"],
  ["ROW-07", "malformed client-migration row or ID fails closed"],
  ["ROW-08", "malformed list row, accessor, proxy, or delegate return shape fails closed"],
  ["ROW-09", "malformed capability SHA fails closed without leaking its value"],
  ["ROW-10", "malformed mode or status enum fails closed"],
  ["TIME-01", "NaN, infinite, fractional, or unsafe Date.now value fails closed"],
  ["OWNED-01", "owned-entry construction failure fails closed"],
  ["OWNED-02", "owned-vector creation failure fails closed"],
  ["OWNED-03", "owned-vector push or root construction failure fails closed"],
  ["REJECT-01", "transaction entry rejection fails closed"],
  ["REJECT-02", "tenantPurgeRun.findUnique rejection fails closed"],
  ["REJECT-03", "workspace.findUnique rejection fails closed"],
  ["REJECT-04", "customerDeployment.findUnique rejection fails closed"],
  ["REJECT-05", "workspace customerDeployment.findMany rejection fails closed"],
  ["REJECT-06", "procurementTrial.findMany rejection fails closed"],
  ["REJECT-07", "customerAccount.findUnique rejection fails closed"],
  ["REJECT-08", "account customerDeployment.findMany rejection fails closed"],
  ["REJECT-09", "customerAccount.findMany rejection fails closed"],
  ["REJECT-10", "procurementTrial.findUnique rejection fails closed"],
  ["REJECT-11", "providerCutover.findFirst rejection fails closed"],
  ["REJECT-12", "clientMigrationRun.findFirst rejection fails closed"],
  ["ACCESS-01", "runtime client ledger permits only one transaction property"],
  ["ACCESS-02", "runtime delegate ledger permits only named findUnique, findFirst, and findMany accesses"],
  ["STATIC-01", "source inspection rejects create, update, upsert, and delete tokens"],
  ["STATIC-02", "source inspection rejects count, aggregate, groupBy, and include tokens"],
  ["STATIC-03", "source inspection rejects queryRaw and executeRaw tokens even for raw SELECT"],
  ["STATIC-04", "source inspection rejects lock, retry, log, route, provider, schema, and migration behavior"],
  ["STATIC-05", "source inspection rejects package-index export and any additional exported symbol"],
  ["STATIC-06", "source inspection rejects a client, reader, request, revision-token, or raw aggregate argument"],
  ["STATIC-07", "source inspection rejects raw object, array, Date, Uint8Array, or Proxy ingress"],
  ["STATIC-08", "an unexpected client, delegate, method, or property access fails at the exact access point"],
] satisfies readonly Case[]);
const STATUSES = FREEZE([
  "DRY_RUN_COMPLETE", "BACKUP_COMPLETE", "RESTORE_VERIFIED", "APPROVED", "EXECUTING", "CLEANUP_PENDING",
  "VERIFYING", "COMPLETED", "RESTORING", "RESTORED", "CANCELLED", "FAILED",
]);
const LEASE_FIELDS = FREEZE([
  "releaseLeaseId", "releaseLeaseTokenHash", "releaseLeaseOwner", "releaseLeaseExpectedImageTag",
  "releaseLeaseIncomingImageTag", "releaseLeaseIncomingVersion", "releaseLeasePhase", "releaseLeaseAcquiredAt",
  "releaseLeaseHeartbeatAt", "releaseLeaseExpiresAt", "releaseLeaseRollbackRecord",
  "releaseLeaseRecoveryEvidence", "releaseLeaseError",
]);
const RUN = "tenantPurgeRun.findUnique({where:{id:runId},select:{mode:true,status:true,targetAccountId:true," +
  "targetDeploymentId:true,targetWorkspaceId:true,targetTrialId:true,canonicalTargetKey:true," +
  "activeTargetKey:true,capabilitySha:true}})";
const TX = "$transaction(callback,{isolationLevel:RepeatableRead,maxWait:5000,timeout:15000})";
const ACCOUNT = FREEZE([TX, RUN, "workspace.findUnique({where:{id:targetWorkspaceId},select:{id:true}})",
  "customerDeployment.findUnique({where:{id:targetDeploymentId},select:{id:true,managedWorkspaceId:true," +
    "customerAccountId:true,releaseLeaseId:true,releaseLeaseTokenHash:true,releaseLeaseOwner:true," +
    "releaseLeaseExpectedImageTag:true,releaseLeaseIncomingImageTag:true,releaseLeaseIncomingVersion:true," +
    "releaseLeasePhase:true,releaseLeaseAcquiredAt:true,releaseLeaseHeartbeatAt:true,releaseLeaseExpiresAt:true," +
    "releaseLeaseRollbackRecord:true,releaseLeaseRecoveryEvidence:true,releaseLeaseError:true}})",
  "customerDeployment.findMany({where:{managedWorkspaceId},select:{id:true},orderBy:{id:asc},take:1001})",
  "procurementTrial.findMany({where:{workspaceId},select:{id:true},orderBy:{id:asc},take:1001})",
  "customerAccount.findUnique({where:{id:targetAccountId},select:{id:true,primaryDeploymentId:true}})",
  "customerDeployment.findMany({where:{customerAccountId},select:{id:true},orderBy:{id:asc},take:1001})",
  "customerAccount.findMany({where:{primaryDeploymentId},select:{id:true},orderBy:{id:asc},take:1001})",
  "providerCutover.findFirst({where:{OR:[customerAccountId,sourceDeploymentId,destinationDeploymentId]}," +
    "select:{id:true},orderBy:{id:asc}})",
  "clientMigrationRun.findFirst({where:{OR:[customerAccountId,sourceDeploymentId,destinationDeploymentId]}," +
    "select:{id:true},orderBy:{id:asc}})"]);
const TRIAL = FREEZE([TX, RUN, ...ACCOUNT.slice(2, 6),
  "procurementTrial.findUnique({where:{id:targetTrialId},select:{id:true,workspaceId:true,trialExpiresAt:true}})",
  ...ACCOUNT.slice(9)]);
const STATIC_RULES = FREEZE([
  /\.(?:create|update|upsert|delete)\b/, /\.(?:count|aggregate|groupBy)\b|\binclude\s*:/,
  /\$(?:queryRaw|executeRaw)\b/, /\b(?:lock|retry|log|route|provider|schema|migration)\b/i,
  /index\.ts|(?:export\s+(?:const|class|function)\s+(?!createTenantPurgePrismaAuthorizeAndCapture\b)){2,}/,
  /\b(?:client|reader|request|revisionToken|rawAggregate)\b/, /\b(?:object|array|Date|Uint8Array|Proxy)\b/,
]);
const ALLOWED_ACCESS = /^\$transaction$|^(?:tenantPurgeRun|workspace|customerDeployment|customerAccount|procurementTrial|providerCutover|clientMigrationRun)(?:\.(?:findUnique|findFirst|findMany))?$/;
function variants(id: string): readonly (string | null)[] {
  if (id === "DENY-02") return STATUSES;
  if (id === "TOPO-15") return LEASE_FIELDS;
  return FREEZE([null]);
}
function calls(id: string): readonly string[] {
  if (id.startsWith("AUTH-") || id.startsWith("FACTORY-") || id.startsWith("STATIC-")) return FREEZE([]);
  if (id.startsWith("DENY-")) return FREEZE([TX, RUN]);
  const accountPrefix = (length: number) => FREEZE(ACCOUNT.slice(0, length));
  if (id === "REJECT-01") return accountPrefix(1);
  if (/^(?:REJECT-02|TIME-01)$/.test(id)) return accountPrefix(2);
  if (/^(?:REJECT-03|ROW-02)$/.test(id)) return accountPrefix(3);
  if (/^(?:REJECT-04|ROW-03)$/.test(id)) return accountPrefix(4);
  if (/^(?:REJECT-05|BOUND-01|BOUND-05)$/.test(id)) return accountPrefix(5);
  if (/^(?:REJECT-06|BOUND-02|BOUND-06)$/.test(id)) return accountPrefix(6);
  if (/^(?:REJECT-07|ROW-04)$/.test(id)) return accountPrefix(7);
  if (/^(?:REJECT-08|BOUND-03|BOUND-07)$/.test(id)) return accountPrefix(8);
  if (/^(?:REJECT-09|BOUND-04|BOUND-08)$/.test(id)) return accountPrefix(9);
  if (id === "REJECT-10" || id === "ROW-05") return FREEZE(TRIAL.slice(0, 7));
  if (id === "REJECT-11" || id === "ROW-06") return accountPrefix(10);
  if (id === "QUERY-14" || id === "TOPO-02" || /^TOPO-(06|09|12|18|19|20|22)$/.test(id)) return TRIAL;
  return ACCOUNT;
}
function expectedAccesses(expectedCalls: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const call of expectedCalls) {
    const path = call.slice(0, call.indexOf("("));
    if (path === "$transaction") result.push(path);
    else { const delegate = path.slice(0, path.indexOf(".")); result.push(delegate, path); }
  }
  return FREEZE(result);
}
function outcome(id: string): unknown {
  if (id.startsWith("DENY-") || id.startsWith("AUTH-") || id === "FACTORY-01") return false;
  if (/^(?:BOUND|ROW|TIME|OWNED|REJECT)-/.test(id)) return "TENANT_PURGE_CONTRACT_INVALID";
  if (id.startsWith("STATIC-") || id.startsWith("ACCESS-")) return "pass";
  if (!id.startsWith("TOPO-")) return FREEZE({ kind: "frozen-result", blockers: FREEZE([]) });
  const blockers = /^TOPO-0[3-6]$|^TOPO-09$/.test(id) ? ["TARGET_TUPLE_MISMATCH"]
    : /^TOPO-0[78]$/.test(id) ? ["SHARED_RESOURCE_AMBIGUITY"]
      : /^TOPO-(10|11)$/.test(id) ? ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]
        : id === "TOPO-12" ? ["LINKED_TRIAL"] : /^TOPO-1[34]$/.test(id) ? ["PRIMARY_ROUTING"]
          : id === "TOPO-15" ? ["MANAGED_RELEASE_LEASE"] : id === "TOPO-16" ? ["PROVIDER_CUTOVER"]
            : id === "TOPO-17" ? ["CLIENT_MIGRATION"] : id === "TOPO-20" ? ["TRIAL_NOT_EXPIRED"]
              : id === "TOPO-21" ? ["LINKED_DEPLOYMENT", "LINKED_TRIAL", "SIBLING_DEPLOYMENT",
                "PRIMARY_ROUTING", "SHARED_RESOURCE_AMBIGUITY", "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER",
                "CLIENT_MIGRATION"] : id === "TOPO-22" ? ["LINKED_ACCOUNT", "LINKED_DEPLOYMENT", "LINKED_TRIAL",
                  "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING", "TRIAL_NOT_EXPIRED", "SHARED_RESOURCE_AMBIGUITY",
                  "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER", "CLIENT_MIGRATION"] : [];
  return FREEZE({ kind: "frozen-result", blockers: FREEZE(blockers) });
}
function injection(id: string): string | null {
  return /^(?:INGRESS|ONESHOT|BOUND|ROW|TIME|OWNED|REJECT)-/.test(id) || id === "STATIC-08" ? id : null;
}
function makeScenario(entry: Case, variant: string | null, source: string): UnitScenario {
  const accesses: string[] = [];
  let fired: string | null = null;
  const expectedCalls = calls(entry[0]);
  const expected = FREEZE({ calls: expectedCalls, outcome: outcome(entry[0]),
    accesses: expectedAccesses(expectedCalls), fired: injection(entry[0]) });
  const trial = entry[0] === "QUERY-14" || /^TOPO-(02|06|09|12|18|19|20|22)$/.test(entry[0]);
  const input = FREEZE({ privateAuthority: !entry[0].startsWith("AUTH-"),
    targetMode: trial ? "SELF_SERVE_TRIAL_WORKSPACE" : "ACCOUNT_WORKSPACE", runId: IDS.runId,
    redactionKeyBytes: KEY, pageSize: 1, maxPagesPerModel: 1, maxEvidenceItems: 1, cacheMaxTtlSeconds: 0 });
  const fixture = FREEZE({ nonce: Symbol(entry[0]), source, variant, mutation: entry[0], ids: IDS, input });
  return FREEZE({ id: entry[0], name: `${entry[0]} ${entry[1]}${variant ? ` [${variant}]` : ""}`, variant,
    fixture, expected,
    access(path: string) { accesses.push(path); if (!ALLOWED_ACCESS.test(path)) throw new Error(`unexpected access: ${path}`); },
    fire(point: string) { if (point !== expected.fired || fired !== null) throw new Error(`unexpected injection: ${point}`); fired = point; },
    observed: () => FREEZE({ accesses: FREEZE(accesses.slice()), fired }),
  });
}
function staticViolation(source: string, index: number): boolean {
  if (index !== 4) return STATIC_RULES[index].test(source);
  const exports = source.match(/\bexport\s+(?:const|class|function)\s+/g) ?? [];
  return /index\.ts/.test(source) || exports.length !== 1 ||
    !/export\s+function\s+createTenantPurgePrismaAuthorizeAndCapture\b/.test(source);
}
function strict(surface: Readonly<Record<string, unknown>>): Readonly<{
  value: unknown; observed(): readonly string[];
}> {
  const accesses: string[] = [];
  const wrap = (node: Readonly<Record<string, unknown>>, prefix: string): unknown => new PROXY(FREEZE(CREATE(null)), {
    get(_target, key) {
      const path = prefix ? `${prefix}.${STRING(key)}` : STRING(key); accesses.push(path);
      const descriptor = DESCRIPTOR(node, key);
      if (!descriptor || !("value" in descriptor)) throw new Error(`unexpected access: ${path}`);
      const value = descriptor.value;
      return value !== null && typeof value === "object" ? wrap(value as Readonly<Record<string, unknown>>, path) : value;
    },
  });
  return FREEZE({ value: wrap(surface, ""), observed: () => FREEZE(accesses.slice()) });
}
function verify(scenario: UnitScenario, evidence: UnitEvidence): void {
  expect(evidence.calls).toEqual(scenario.expected.calls);
  expect(evidence.outcome).toEqual(scenario.expected.outcome);
  expect(evidence.accesses).toEqual(scenario.expected.accesses);
  expect(scenario.observed().accesses).toEqual(scenario.expected.accesses);
  expect(evidence.fired).toBe(scenario.expected.fired);
  expect(Object.isFrozen(scenario.fixture)).toBe(true);
  expect(Object.isFrozen(scenario.expected)).toBe(true);
}
function register(loadAdapterFactoryProbe: UnitAdapterFactoryProbeLoader, source: string): readonly string[] {
  const names: string[] = [];
  for (const entry of CASES) for (const variant of variants(entry[0])) {
    const scenario = makeScenario(entry, variant, source); names.push(scenario.name);
    it(scenario.name, async () => {
      if (entry[0].startsWith("STATIC-") && entry[0] !== "STATIC-08") {
        expect(staticViolation(source, Number(entry[0].slice(7)) - 1)).toBe(false); return;
      }
      verify(scenario, await (await loadAdapterFactoryProbe())(scenario));
    });
  }
  return FREEZE(names);
}
export const tenantPurgePrismaReaderUnitHarness = FREEZE({
  cases: CASES, register, makeScenario,
  inspect(source: string): readonly boolean[] { return FREEZE(STATIC_RULES.map((_rule, index) =>
    staticViolation(source, index))); },
  strict, verify,
});
