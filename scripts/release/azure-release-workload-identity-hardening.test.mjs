import { describe, expect, test } from "vitest";
import { assessAzureReleaseWorkloadIdentity } from "./azure-release-workload-identity.mjs";

describe("Azure release workload identity semantic hardening", () => {
  test("rejects every missing own-group value category", () => {
    const rows = [
      { name: "undefined", target: { provider: "azure", group: undefined, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "null", target: { provider: "azure", group: null, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "true", target: { provider: "azure", group: true, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "false", target: { provider: "azure", group: false, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "zero", target: { provider: "azure", group: 0, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "one", target: { provider: "azure", group: 1, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "negative-one", target: { provider: "azure", group: -1, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "nan", target: { provider: "azure", group: NaN, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "positive-infinity", target: { provider: "azure", group: Infinity, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "negative-infinity", target: { provider: "azure", group: -Infinity, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "bigint", target: { provider: "azure", group: 1n, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "symbol", target: { provider: "azure", group: Symbol("group-symbol"), workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "function", target: { provider: "azure", group: () => {}, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "empty-array", target: { provider: "azure", group: [], workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "populated-array", target: { provider: "azure", group: ["ops"], workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "plain-object", target: { provider: "azure", group: {}, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "date", target: { provider: "azure", group: new Date(0), workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "map", target: { provider: "azure", group: new Map(), workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "set", target: { provider: "azure", group: new Set(), workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "regex", target: { provider: "azure", group: /ops/, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "unicode-whitespace", target: { provider: "azure", group: "\u00a0", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { name: "railway-customers-alias", target: { provider: "azure", group: "railway-customers", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } },
      { name: "azure-selfserve-alias", target: { provider: "azure", group: "azure-selfserve", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } }
    ];
    expect(rows).toHaveLength(23);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(23);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual(expected);
    }
  });

  test("rejects every missing own-workload value category", () => {
    const rows = [
      { name: "undefined", target: { provider: "azure", group: "ops", workload: undefined }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "null", target: { provider: "azure", group: "ops", workload: null }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "true", target: { provider: "azure", group: "ops", workload: true }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "false", target: { provider: "azure", group: "ops", workload: false }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "zero", target: { provider: "azure", group: "ops", workload: 0 }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "one", target: { provider: "azure", group: "ops", workload: 1 }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "negative-one", target: { provider: "azure", group: "ops", workload: -1 }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "nan", target: { provider: "azure", group: "ops", workload: NaN }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "positive-infinity", target: { provider: "azure", group: "ops", workload: Infinity }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "negative-infinity", target: { provider: "azure", group: "ops", workload: -Infinity }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "bigint", target: { provider: "azure", group: "ops", workload: 1n }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "symbol", target: { provider: "azure", group: "ops", workload: Symbol("workload-symbol") }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "function", target: { provider: "azure", group: "ops", workload: () => {} }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "empty-array", target: { provider: "azure", group: "ops", workload: [] }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "populated-array", target: { provider: "azure", group: "ops", workload: ["ops"] }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "plain-object", target: { provider: "azure", group: "ops", workload: {} }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "date", target: { provider: "azure", group: "ops", workload: new Date(0) }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "map", target: { provider: "azure", group: "ops", workload: new Map() }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "set", target: { provider: "azure", group: "ops", workload: new Set() }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "regex", target: { provider: "azure", group: "ops", workload: /ops/ }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "unicode-whitespace", target: { provider: "azure", group: "ops", workload: "\u2003" }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { name: "railway-customers-alias", target: { provider: "azure", group: "ops", workload: "railway-customers" }, expected: { status: "blocked", blockerCodes: ["azure_workload_mismatch"], identity: null } },
      { name: "azure-selfserve-alias", target: { provider: "azure", group: "ops", workload: "azure-selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_workload_mismatch"], identity: null } }
    ];
    expect(rows).toHaveLength(23);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(23);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual(expected);
    }
  });

  test("rejects every missing top-level malformed category", () => {
    const inheritedOnlyProviderTarget = Object.create({ provider: "azure" });
    const rows = [
      { name: "true", target: true, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "false", target: false, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "zero", target: 0, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "one", target: 1, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "negative-one", target: -1, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "nan", target: NaN, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "positive-infinity", target: Infinity, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "negative-infinity", target: -Infinity, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "bigint", target: 1n, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "symbol", target: Symbol("top-level-symbol"), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "function", target: () => {}, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "empty-array", target: [], expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "populated-array", target: ["azure"], expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "date", target: new Date(0), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "map", target: new Map(), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "set", target: new Set(), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "regex", target: /azure/, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "inherited-only-provider", target: inheritedOnlyProviderTarget, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } }
    ];
    expect(rows).toHaveLength(18);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(18);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual(expected);
    }
  });

  test("honors non-enumerable group and workload data properties", () => {
    const target = { provider: "azure" };
    Object.defineProperty(target, "group", {
      value: "ops",
      enumerable: false,
      writable: true,
      configurable: true
    });
    Object.defineProperty(target, "workload", {
      value: "ops",
      enumerable: false,
      writable: true,
      configurable: true
    });
    expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
  });

  test("rejects setter-only group and workload without invocation", () => {
    let groupSetterCount = 0;
    const setterGroup = { provider: "azure", workload: "ops" };
    Object.defineProperty(setterGroup, "group", {
      set(value) {
        groupSetterCount += 1;
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(setterGroup)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_group_missing"], identity: null });
    expect(groupSetterCount).toBe(0);

    let workloadSetterCount = 0;
    const setterWorkload = { provider: "azure", group: "ops" };
    Object.defineProperty(setterWorkload, "workload", {
      set(value) {
        workloadSetterCount += 1;
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(setterWorkload)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null });
    expect(workloadSetterCount).toBe(0);
  });

  test("fails closed for every missing hostile inspection path", () => {
    let secondPrototypeCallCount = 0;
    const secondPrototypeFailure = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      getPrototypeOf(target) {
        secondPrototypeCallCount += 1;
        if (secondPrototypeCallCount === 2) {
          throw new Error("second prototype inspection failed");
        }
        return Reflect.getPrototypeOf(target);
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(secondPrototypeFailure)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_group_missing", "azure_workload_missing"], identity: null });
    expect(secondPrototypeCallCount).toBe(2);

    const providerDescriptorError = new Error("provider descriptor inspection failed");
    const providerDescriptorFailure = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "provider") {
          throw providerDescriptorError;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    const providerDescriptorResult = assessAzureReleaseWorkloadIdentity(providerDescriptorFailure);
    expect(providerDescriptorResult).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null });
    expect(providerDescriptorResult).not.toBe(providerDescriptorError);
    expect(JSON.stringify(providerDescriptorResult).includes(providerDescriptorError.message)).toBe(false);

    const workloadDescriptorFailure = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "workload") {
          throw new Error("workload descriptor inspection failed");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(workloadDescriptorFailure)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null });
  });

  test("never invokes unrelated proxy traps", () => {
    let getCount = 0;
    let hasCount = 0;
    let ownKeysCount = 0;
    const target = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      get() {
        getCount += 1;
        throw new Error("get trap invoked");
      },
      has() {
        hasCount += 1;
        throw new Error("has trap invoked");
      },
      ownKeys() {
        ownKeysCount += 1;
        throw new Error("ownKeys trap invoked");
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
    expect(getCount).toBe(0);
    expect(hasCount).toBe(0);
    expect(ownKeysCount).toBe(0);
  });

  test("covers every missing prerequisite and multi-defect combination", () => {
    const rows = [
      { name: "provider-and-group-missing-mismatch-suppressed", target: { provider: "aws", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing"], identity: null } },
      { name: "provider-and-group-unsupported-mismatch-suppressed", target: { provider: "aws", group: "customers", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_unsupported"], identity: null } },
      { name: "provider-and-workload-missing", target: { provider: "aws", group: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_workload_missing"], identity: null } },
      { name: "provider-and-workload-mismatch", target: { provider: "aws", group: "ops", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_workload_mismatch"], identity: null } },
      { name: "group-and-workload-missing", target: { provider: "azure" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "unsupported-group-and-workload-missing", target: { provider: "azure", group: "customers" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported", "azure_workload_missing"], identity: null } },
      { name: "provider-group-and-workload-missing", target: { provider: "aws" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { name: "provider-only-with-ready-workload", target: { provider: "aws", group: "ops", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } }
    ];
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(8);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseWorkloadIdentity(target)).toStrictEqual(expected);
    }
  });

  test("keeps every returned value fresh and mutation-independent", () => {
    const input = { provider: "azure", group: "ops", workload: "ops", metadata: { marker: "fresh-input-marker" } };
    const first = assessAzureReleaseWorkloadIdentity(input);
    first.status = "mutated";
    first.blockerCodes.push("mutated");
    first.identity.provider = "mutated";
    first.identity.group = "mutated";
    first.identity.workload = "mutated";
    expect(assessAzureReleaseWorkloadIdentity(input)).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
    expect(input).toStrictEqual({ provider: "azure", group: "ops", workload: "ops", metadata: { marker: "fresh-input-marker" } });

    const blockedInput = { provider: "aws", group: "ops", workload: "ops", metadata: { marker: "blocked-input-marker" } };
    const blockedFirst = assessAzureReleaseWorkloadIdentity(blockedInput);
    const blockedSecond = assessAzureReleaseWorkloadIdentity(blockedInput);
    expect(Object.keys(blockedFirst)).toStrictEqual(["status", "blockerCodes", "identity"]);
    expect(Object.getPrototypeOf(blockedFirst)).toBe(Object.prototype);
    expect(blockedFirst).not.toBe(blockedSecond);
    expect(blockedFirst).not.toBe(blockedInput);
    expect(blockedFirst.blockerCodes).not.toBe(blockedSecond.blockerCodes);
    expect(blockedFirst.identity).toBeNull();
    blockedFirst.status = "mutated";
    blockedFirst.blockerCodes.push("mutated");
    expect(blockedSecond).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null });
    expect(assessAzureReleaseWorkloadIdentity(blockedInput)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null });
    expect(blockedInput).toStrictEqual({ provider: "aws", group: "ops", workload: "ops", metadata: { marker: "blocked-input-marker" } });
  });

  test("never returns any exact ignored sentinel", () => {
    const topSymbolKey = Symbol("top-ignored-symbol");
    const nestedSymbolKey = Symbol("nested-ignored-symbol");
    const input = {
      provider: "azure",
      group: "ops",
      workload: "ops",
      azure: "safe-01-top",
      subscriptionId: "safe-02-top",
      resourceGroup: "safe-03-top",
      acrName: "safe-04-top",
      acrServer: "safe-05-top",
      webAppName: "safe-06-top",
      workerAppName: "safe-07-top",
      applicationInsightsConnectionString: "safe-08-top",
      runtimeOrigin: "safe-09-top",
      url: "safe-10-top",
      image: "safe-11-top",
      digest: "safe-12-top",
      revision: "safe-13-top",
      action: "safe-14-top",
      operation: "safe-15-top",
      credential: "aaaaaaaaaaaaaaaaaaaa",
      secret: "bbbbbbbbbbbbbbbbbbbb",
      unknownFutureKey: "cccccccccccccccccccc",
      ignored: {
        azure: "safe-19-nested",
        subscriptionId: "safe-20-nested",
        resourceGroup: "safe-21-nested",
        acrName: "safe-22-nested",
        acrServer: "safe-23-nested",
        webAppName: "safe-24-nested",
        workerAppName: "safe-25-nested",
        applicationInsightsConnectionString: "safe-26-nested",
        runtimeOrigin: "safe-27-nested",
        url: "safe-28-nested",
        image: "safe-29-nested",
        digest: "safe-30-nested",
        revision: "safe-31-nested",
        action: "safe-32-nested",
        operation: "safe-33-nested",
        credential: "dddddddddddddddddddd",
        secret: "eeeeeeeeeeeeeeeeeeee",
        unknownFutureKey: "ffffffffffffffffffff",
        [nestedSymbolKey]: "safe-38-nested-symbol"
      },
      [topSymbolKey]: "safe-37-top-symbol"
    };
    const markerValues = [
      ...Object.values(input).filter((value) => typeof value === "string" && value !== "azure" && value !== "ops"),
      ...Object.values(input.ignored),
      input[topSymbolKey],
      input.ignored[nestedSymbolKey]
    ];
    expect(Reflect.ownKeys(input)).toHaveLength(23);
    expect(Reflect.ownKeys(input.ignored)).toHaveLength(19);
    expect(markerValues).toHaveLength(38);
    expect(new Set(markerValues).size).toBe(38);
    expect(topSymbolKey.description).not.toBe(nestedSymbolKey.description);
    const result = assessAzureReleaseWorkloadIdentity(input);
    expect(result).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
    const serialized = JSON.stringify(result);
    for (const markerValue of markerValues) {
      expect(serialized.includes(markerValue)).toBe(false);
    }
    expect(serialized.includes(topSymbolKey.description)).toBe(false);
    expect(serialized.includes(nestedSymbolKey.description)).toBe(false);
  });
});
