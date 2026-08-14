import { Prisma } from "@prisma/client"; import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TENANT_PURGE_BLOCKER_CODES,
  TENANT_PURGE_MODEL_CLASSIFICATION, TENANT_PURGE_SPECIAL_SCOPE_SELECTORS,
  assertTenantPurgeModelCoverage,
  buildTenantPurgeManifest,
  type TenantPurgeEvidenceItem,
  type TenantPurgeReadAdapter,
  type TenantPurgeTarget,
  type TenantPurgeTopology,
} from "./tenant-purge-manifest";

const SHA = "a".repeat(40);
const REDACTION_KEY = new Uint8Array(32).fill(7);
const accountTarget = { mode: "ACCOUNT_WORKSPACE", accountId: "00000000-0000-4000-8000-000000000001", deploymentId: "00000000-0000-4000-8000-000000000002", workspaceId: "00000000-0000-4000-8000-000000000003" } as const;
const trialTarget = { mode: "SELF_SERVE_TRIAL_WORKSPACE", trialId: "00000000-0000-4000-8000-000000000004", deploymentId: "00000000-0000-4000-8000-000000000002", workspaceId: "00000000-0000-4000-8000-000000000003" } as const;

function topology(target: TenantPurgeTarget): TenantPurgeTopology {
  return {
    capturedAt: new Date("2026-08-13T12:00:00.000Z"),
    workspace: {
      id: target.workspaceId,
      managedDeploymentIds: [target.deploymentId],
      trialIds: target.mode === "SELF_SERVE_TRIAL_WORKSPACE" ? [target.trialId] : [],
    },
    deployment: {
      id: target.deploymentId,
      managedWorkspaceId: target.workspaceId,
      accountId: target.mode === "ACCOUNT_WORKSPACE" ? target.accountId : null,
      primaryAccountIds: [],
      providerResourceLocators: ["provider-resource-private"],
      sharedResourceAmbiguous: false,
      hasManagedReleaseLease: false,
    },
    account: target.mode === "ACCOUNT_WORKSPACE"
      ? { id: target.accountId, deploymentIds: [target.deploymentId], primaryDeploymentId: null }
      : null,
    trial: target.mode === "SELF_SERVE_TRIAL_WORKSPACE" ? { id: target.trialId, workspaceId: target.workspaceId, status: "EXPIRED" } : null,
  };
}

function adapter(options: {
  target: TenantPurgeTarget; rows?: Partial<Record<Prisma.ModelName, TenantPurgeEvidenceItem[]>>; reverse?: boolean;
  topology?: TenantPurgeTopology; seenModels?: Set<Prisma.ModelName>; authorized?: boolean;
}): TenantPurgeReadAdapter {
  return {
    async isTargetAuthorized() { return options.authorized ?? true; }, async readConsistencyToken() { return "stable-snapshot"; },
    async readTopology() {
      return options.topology ?? topology(options.target);
    },
    async readModelPage({ model, cursor, pageSize }) {
      options.seenModels?.add(model);
      const rows = [...(options.rows?.[model] ?? [])];
      if (options.reverse) rows.reverse();
      const start = cursor ? Number(cursor) : 0;
      const items = rows.slice(start, start + pageSize);
      const next = start + items.length;
      return { model, items, nextCursor: next < rows.length ? String(next) : null };
    },
  };
}

describe("tenant purge manifest", () => {
  it("classifies every generated Prisma model exactly once and detects drift", () => {
    const classified = Object.values(TENANT_PURGE_MODEL_CLASSIFICATION).flat();
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...Object.values(Prisma.ModelName)].sort());
    expect(() => assertTenantPurgeModelCoverage()).not.toThrow();
    expect(() => assertTenantPurgeModelCoverage([...Object.values(Prisma.ModelName), "FutureModel" as Prisma.ModelName])).toThrow(/missing=FutureModel/);
    expect(() => assertTenantPurgeModelCoverage(Object.values(Prisma.ModelName).slice(1))).toThrow(/removed=/); const expectedSpecial = { AppRelease: ["runtime.customerDeploymentId"], AppRuntime: ["customerDeploymentId"], ClientMigrationIdMap: ["migrationRun.customerAccountId", "migrationRun.sourceDeploymentId", "migrationRun.destinationDeploymentId"], ClientMigrationRun: ["customerAccountId", "sourceDeploymentId", "destinationDeploymentId"], CrmProspectWorkspace: ["crmWorkspaceId", "targetWorkspaceId"], CustomerDeploymentAccess: ["deploymentId"], CustomerDeploymentEvent: ["deploymentId"], CustomerEntitlement: ["customerAccountId", "deploymentId"], CustomerReleaseTarget: ["customerAccountId", "deploymentId"], FleetHealthSnapshot: ["customerAccountId", "deploymentId"], MeetingRecorderSmokeRun: ["workspaceId", "deploymentId"], ProcurementIdempotencyKey: ["workspaceId", "setupSessionId->ProcurementSetupSession.workspaceId"], ProviderCutover: ["customerAccountId", "sourceDeploymentId", "destinationDeploymentId"], SelfServeEmailCapture: ["workspaceId", "procurementTrialId"], SelfServeSmokeRun: ["workspaceId", "deploymentId", "procurementTrialId"], SelfServeSupportSession: ["workspaceId", "deploymentId"], SupportOperation: ["workspaceId", "deploymentId"] }; expect(TENANT_PURGE_SPECIAL_SCOPE_SELECTORS).toEqual(expectedSpecial); expect(TENANT_PURGE_MODEL_CLASSIFICATION.CONTROL_PLANE_LINKED.every((model) => model in TENANT_PURGE_SPECIAL_SCOPE_SELECTORS)).toBe(true); const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8"); for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) { const actions = [...match[2].matchAll(/\w+\s+Workspace\??\s+@relation\([^\n]*onDelete:\s*(Cascade|SetNull)/g)].map((relation) => relation[1]); if (!TENANT_PURGE_MODEL_CLASSIFICATION.TARGET.includes(match[1] as never) && actions.includes("Cascade")) expect(TENANT_PURGE_MODEL_CLASSIFICATION.WORKSPACE_CASCADE).toContain(match[1]); else if (!TENANT_PURGE_MODEL_CLASSIFICATION.TARGET.includes(match[1] as never) && actions.includes("SetNull")) expect(TENANT_PURGE_MODEL_CLASSIFICATION.WORKSPACE_SET_NULL).toContain(match[1]); const directScopes = [...match[2].matchAll(/^\s+(workspaceId|deploymentId|customerDeploymentId|customerAccountId|procurementTrialId|sourceDeploymentId|destinationDeploymentId|crmWorkspaceId|targetWorkspaceId)\s+/gm)].map((field) => field[1]); if (directScopes.length > 1) expect([...TENANT_PURGE_SPECIAL_SCOPE_SELECTORS[match[1] as keyof typeof TENANT_PURGE_SPECIAL_SCOPE_SELECTORS]].sort()).toEqual(directScopes.sort()); }
  });

  it("paginates every model, redacts private values, and produces a boundary-independent digest", async () => {
    const privateRows: Partial<Record<Prisma.ModelName, TenantPurgeEvidenceItem[]>> = {
      Document: [
        { recordId: "document-private-1", locators: [{ kind: "STORAGE_KEY", value: "outside-standard-prefix/private-1" }] },
        { recordId: "document-private-2", locators: [{ kind: "AZURE_SEARCH_ID", value: "search-private-2" }] },
        { recordId: "document-private-3", locators: [{ kind: "CACHE_KEY", value: "cache-private-3", ttlSeconds: 120 }] },
      ],
    };
    const seen = new Set<Prisma.ModelName>();
    const first = await buildTenantPurgeManifest({
      target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows: privateRows, seenModels: seen }),
      pageSize: 1, cachePolicyMaxTtlSeconds: 300,
    });
    const second = await buildTenantPurgeManifest({
      target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows: privateRows, reverse: true }),
      pageSize: 2, cachePolicyMaxTtlSeconds: 300,
    });
    expect(seen).toEqual(new Set(Object.values(Prisma.ModelName)));
    expect(first.digest).toBe(second.digest);
    expect(first.blockers).toEqual([]); expect(() => first.blockers.push("LEGAL_HOLD")).toThrow();
    expect(first.cache).toEqual({ keyCount: 1, maxObservedTtlSeconds: 120, policyMaxTtlSeconds: 300 });
    const returned = JSON.stringify(first);
    for (const secret of [accountTarget.accountId, accountTarget.deploymentId, accountTarget.workspaceId, "document-private", "outside-standard-prefix", "search-private", "cache-private", "provider-resource-private"]) {
      expect(returned).not.toContain(secret);
    }
  });

  it("supports the exact trial/workspace topology without inferring an account", async () => {
    const manifest = await buildTenantPurgeManifest({ target: trialTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: trialTarget }) });
    expect(manifest.target.mode).toBe("SELF_SERVE_TRIAL_WORKSPACE");
    expect(manifest.blockers).toEqual([]); const primaryElsewhere = topology(accountTarget); primaryElsewhere.account!.primaryDeploymentId = "other-primary"; const blocked = await buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, topology: primaryElsewhere }) }); expect(blocked.blockers).toEqual(["LINKED_DEPLOYMENT", "PRIMARY_ROUTING", "SIBLING_DEPLOYMENT"]); const primaryLinked = topology(trialTarget); primaryLinked.deployment!.primaryAccountIds = ["linked-account"]; expect((await buildTenantPurgeManifest({ target: trialTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: trialTarget, topology: primaryLinked }) })).blockers).toContain("LINKED_ACCOUNT");
  });

  it("fails closed with the complete blocker vocabulary", async () => {
    const unsafe = topology(accountTarget);
    unsafe.workspace = { id: "wrong-workspace", managedDeploymentIds: [accountTarget.deploymentId, "sibling"], trialIds: ["linked-trial"] };
    unsafe.deployment = {
      ...unsafe.deployment!, accountId: "other-account", primaryAccountIds: ["account-a"], providerResourceLocators: [""], sharedResourceAmbiguous: false, hasManagedReleaseLease: true,
    };
    unsafe.account = { id: "other-account", deploymentIds: [accountTarget.deploymentId, "sibling"], primaryDeploymentId: accountTarget.deploymentId };
    unsafe.trial = { id: "linked-trial", workspaceId: "wrong-workspace", status: "ACTIVE" };
    const evidenceOnly = TENANT_PURGE_BLOCKER_CODES.filter((code) => ![
      "TARGET_TUPLE_MISMATCH", "LINKED_DEPLOYMENT", "LINKED_TRIAL", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING",
      "SHARED_RESOURCE_AMBIGUITY", "MANAGED_RELEASE_LEASE", "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED",
    ].includes(code));
    const rows = {
      WorkflowJob: [{
        recordId: "unsafe-row", blockers: evidenceOnly,
        locators: [
          { kind: "RATE_LIMIT_KEY", value: "rate-private", ttlSeconds: 900 },
          { kind: "CACHE_KEY", value: "cache-unbounded-private", ttlSeconds: null },
        ],
      }],
    } satisfies Partial<Record<Prisma.ModelName, TenantPurgeEvidenceItem[]>>;
    const manifest = await buildTenantPurgeManifest({
      target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows, topology: unsafe }), cachePolicyMaxTtlSeconds: 60,
    });
    expect(manifest.blockers).toEqual([...TENANT_PURGE_BLOCKER_CODES].sort());
  });

  it("rejects cursor cycles and unsafe bounds", async () => {
    const cycling: TenantPurgeReadAdapter = {
      async isTargetAuthorized() { return true; }, async readConsistencyToken() { return "stable-snapshot"; }, async readTopology() { return topology(accountTarget); },
      async readModelPage({ model, cursor }) { return { model, items: [{ recordId: `row-${cursor ?? "first"}` }], nextCursor: "same" }; },
    };
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: cycling })).rejects.toThrow(/cursor cycle/);
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }), pageSize: 0 })).rejects.toThrow(/pagination bounds/); await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }), maxPagesPerModel: 1_001 })).rejects.toThrow(/pagination bounds/);
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: new Uint8Array(31), reader: adapter({ target: accountTarget }) })).rejects.toThrow(/redaction key/);
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, authorized: false }) })).rejects.toThrow(/not authorized/); await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: { ...adapter({ target: accountTarget }), async isTargetAuthorized() { return 1 as never; } } })).rejects.toThrow(/not authorized/);
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: { ...cycling, async readModelPage({ model }) { return { model, items: [{ recordId: "row" }], nextCursor: "" }; } } })).rejects.toThrow(/page/);
    const original = await buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }) }); const mutableTarget = { ...accountTarget } as { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }; const stableReader = adapter({ target: accountTarget }); const mutableInput = { target: mutableTarget, capabilitySha: SHA, redactionKey: Uint8Array.from(REDACTION_KEY), reader: stableReader, pageSize: 250, maxPagesPerModel: 1_000, cachePolicyMaxTtlSeconds: null as number | null }; stableReader.isTargetAuthorized = async () => { await Promise.resolve(); mutableTarget.accountId = "00000000-0000-4000-8000-000000000099"; mutableInput.capabilitySha = "b".repeat(40); mutableInput.redactionKey.fill(9); mutableInput.pageSize = 0; mutableInput.maxPagesPerModel = 0; mutableInput.cachePolicyMaxTtlSeconds = Number.POSITIVE_INFINITY; mutableInput.reader = cycling; return true; }; expect(await buildTenantPurgeManifest(mutableInput)).toEqual(original); let tokenRead = 0; await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: { ...adapter({ target: accountTarget }), async readConsistencyToken() { return String(++tokenRead); } } })).rejects.toThrow(/changed/);
  });

  it("rejects non-UUID targets and duplicate or empty evidence", async () => {
    await expect(buildTenantPurgeManifest({ target: { ...accountTarget, accountId: "account-a" }, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }) })).rejects.toThrow(/exact/); await expect(buildTenantPurgeManifest({ target: { ...accountTarget, accountId: [accountTarget.accountId] } as never, capabilitySha: [SHA] as never, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }) })).rejects.toThrow(/exact/); await expect(buildTenantPurgeManifest({ target: { ...accountTarget, accountId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }) })).rejects.toThrow(/exact/);
    await expect(buildTenantPurgeManifest({ target: { ...accountTarget, trialId: trialTarget.trialId } as TenantPurgeTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }) })).rejects.toThrow(/exact/); await expect(buildTenantPurgeManifest({ target: { ...trialTarget, mode: "UNKNOWN" } as never, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: trialTarget }) })).rejects.toThrow(/exact/);
    for (const rows of [
      [{ recordId: "duplicate" }, { recordId: "duplicate" }], [{ recordId: "" }], [{ recordId: "row", locators: [{ kind: "STORAGE_KEY" as const, value: "" }] }], [{ recordId: "row", blockers: ["UNKNOWN" as never] }], [{ recordId: "row", locators: [{ kind: "UNKNOWN" as never, value: "value" }] }],
    ]) {
      await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows: { Document: rows } }) })).rejects.toThrow(/Invalid|duplicate/);
    }
    expect((await buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows: { Document: [{ recordId: "row", locators: [{ kind: "CACHE_KEY", value: "cache", ttlSeconds: Number.NaN }] }] } }) })).blockers).toContain("CACHE_TTL_UNBOUNDED");
    await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget }), cachePolicyMaxTtlSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow(/TTL policy/); const many = Array.from({ length: 100_000 }, (_, index) => ({ recordId: `row-${index}` })); await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, rows: { Document: many } }), pageSize: 1_000 })).rejects.toThrow(/evidence limit/); const providerHeavy = topology(accountTarget); providerHeavy.deployment!.providerResourceLocators = Array.from({ length: 100_001 }, (_, index) => `provider-${index}`); await expect(buildTenantPurgeManifest({ target: accountTarget, capabilitySha: SHA, redactionKey: REDACTION_KEY, reader: adapter({ target: accountTarget, topology: providerHeavy }) })).rejects.toThrow(/evidence limit/);
  });
});
