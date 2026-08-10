import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AZURE_RELEASE_CONTRACT_STATUS as PROVIDER_CONTRACT_STATUS } from "./azure-release-provider-identity.mjs";
import * as workloadIdentityModule from "./azure-release-workload-identity.mjs";
import {
  AZURE_RELEASE_CONTRACT_STATUS,
  AZURE_RELEASE_WORKLOAD_BLOCKER_CODE,
  assessAzureReleaseWorkloadIdentity
} from "./azure-release-workload-identity.mjs";

const productionSource = readFileSync(new URL("./azure-release-workload-identity.mjs", import.meta.url), "utf8");

describe("Azure release workload identity core", () => {
  test("exports the exact frozen surface and provider status identity", () => {
    expect(Object.keys(workloadIdentityModule)).toStrictEqual([
      "AZURE_RELEASE_CONTRACT_STATUS",
      "AZURE_RELEASE_WORKLOAD_BLOCKER_CODE",
      "assessAzureReleaseWorkloadIdentity"
    ]);
    expect(AZURE_RELEASE_CONTRACT_STATUS).toBe(PROVIDER_CONTRACT_STATUS);
    expect(Object.isFrozen(AZURE_RELEASE_CONTRACT_STATUS)).toBe(true);
    expect(Object.isFrozen(AZURE_RELEASE_WORKLOAD_BLOCKER_CODE)).toBe(true);
    expect(Object.keys(AZURE_RELEASE_WORKLOAD_BLOCKER_CODE)).toStrictEqual([
      "AZURE_GROUP_MISSING",
      "AZURE_GROUP_UNSUPPORTED",
      "AZURE_WORKLOAD_MISSING",
      "AZURE_WORKLOAD_MISMATCH"
    ]);
    expect(AZURE_RELEASE_WORKLOAD_BLOCKER_CODE).toStrictEqual({
      AZURE_GROUP_MISSING: "azure_group_missing",
      AZURE_GROUP_UNSUPPORTED: "azure_group_unsupported",
      AZURE_WORKLOAD_MISSING: "azure_workload_missing",
      AZURE_WORKLOAD_MISMATCH: "azure_workload_mismatch"
    });
  });

  test("accepts each exact supported group with a matching workload", () => {
    const rows = [
      { target: { provider: "azure", group: "managed-customers", workload: "managed-customers" }, expected: { status: "ready", blockerCodes: [], identity: { provider: "azure", group: "managed-customers", workload: "managed-customers" } } },
      { target: { provider: "azure", group: "selfserve", workload: "selfserve" }, expected: { status: "ready", blockerCodes: [], identity: { provider: "azure", group: "selfserve", workload: "selfserve" } } },
      { target: { provider: "azure", group: "ops", workload: "ops" }, expected: { status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } } },
      { target: { provider: "azure", group: "backup-app", workload: "backup-app" }, expected: { status: "ready", blockerCodes: [], identity: { provider: "azure", group: "backup-app", workload: "backup-app" } } }
    ];
    for (const row of rows) {
      expect(assessAzureReleaseWorkloadIdentity(row.target)).toStrictEqual(row.expected);
    }
  });

  test("composes provider authority without reading provider values", () => {
    const wrongProvider = { provider: "aws", group: "ops", workload: "ops" };
    expect(assessAzureReleaseWorkloadIdentity(wrongProvider)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null });

    let providerGetterCount = 0;
    const accessorProvider = { group: "ops", workload: "ops" };
    Object.defineProperty(accessorProvider, "provider", {
      get() {
        providerGetterCount += 1;
        return "azure";
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(accessorProvider)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null });
    expect(providerGetterCount).toBe(0);
  });

  test("rejects representative missing and unsupported groups", () => {
    const rows = [
      { target: { provider: "azure", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { target: { provider: "azure", group: "", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { target: { provider: "azure", group: "   ", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { target: { provider: "azure", group: 7, workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { target: { provider: "azure", group: " ops ", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } },
      { target: { provider: "azure", group: "Ops", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } },
      { target: { provider: "azure", group: "customers", workload: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } }
    ];
    for (const row of rows) {
      expect(assessAzureReleaseWorkloadIdentity(row.target)).toStrictEqual(row.expected);
    }

    let groupGetterCount = 0;
    const accessorGroup = { provider: "azure", workload: "ops" };
    Object.defineProperty(accessorGroup, "group", {
      get() {
        groupGetterCount += 1;
        return "ops";
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(accessorGroup)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_group_missing"], identity: null });
    expect(groupGetterCount).toBe(0);

    const inheritedGroup = Object.create({ group: "ops" });
    inheritedGroup.provider = "azure";
    inheritedGroup.workload = "ops";
    expect(assessAzureReleaseWorkloadIdentity(inheritedGroup)).toStrictEqual({
      status: "blocked",
      blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"],
      identity: null
    });
  });

  test("rejects representative missing and mismatching workloads", () => {
    const rows = [
      { target: { provider: "azure", group: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: "" }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: "   " }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: 7 }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: " ops " }, expected: { status: "blocked", blockerCodes: ["azure_workload_mismatch"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: "Ops" }, expected: { status: "blocked", blockerCodes: ["azure_workload_mismatch"], identity: null } },
      { target: { provider: "azure", group: "ops", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_workload_mismatch"], identity: null } }
    ];
    for (const row of rows) {
      expect(assessAzureReleaseWorkloadIdentity(row.target)).toStrictEqual(row.expected);
    }

    let workloadGetterCount = 0;
    const accessorWorkload = { provider: "azure", group: "ops" };
    Object.defineProperty(accessorWorkload, "workload", {
      get() {
        workloadGetterCount += 1;
        return "ops";
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(accessorWorkload)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null });
    expect(workloadGetterCount).toBe(0);

    const inheritedWorkload = Object.create({ workload: "ops" });
    inheritedWorkload.provider = "azure";
    inheritedWorkload.group = "ops";
    expect(assessAzureReleaseWorkloadIdentity(inheritedWorkload)).toStrictEqual({
      status: "blocked",
      blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"],
      identity: null
    });
  });

  test("suppresses dependent mismatch blockers", () => {
    const rows = [
      { target: { provider: "azure", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_group_missing"], identity: null } },
      { target: { provider: "azure", group: "customers", workload: "selfserve" }, expected: { status: "blocked", blockerCodes: ["azure_group_unsupported"], identity: null } },
      { target: { provider: "azure", group: "ops" }, expected: { status: "blocked", blockerCodes: ["azure_workload_missing"], identity: null } }
    ];
    for (const row of rows) {
      expect(assessAzureReleaseWorkloadIdentity(row.target)).toStrictEqual(row.expected);
    }
  });

  test("orders and deduplicates composite blockers independent of insertion order", () => {
    const providerFirst = { provider: "aws", group: "customers", workload: 7 };
    const providerLast = { workload: 7, group: "customers", provider: "aws" };
    expect(assessAzureReleaseWorkloadIdentity(providerFirst)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_unsupported", "azure_workload_missing"], identity: null });
    expect(assessAzureReleaseWorkloadIdentity(providerLast)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_unsupported", "azure_workload_missing"], identity: null });
    expect(new Set(assessAzureReleaseWorkloadIdentity(providerFirst).blockerCodes).size).toBe(3);
  });

  test("fails closed for malformed topology and required proxy inspection", () => {
    const malformedRows = [
      { target: undefined, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { target: null, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } },
      { target: "ops", expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null } }
    ];
    for (const row of malformedRows) {
      expect(assessAzureReleaseWorkloadIdentity(row.target)).toStrictEqual(row.expected);
    }

    class WorkloadTarget {
      constructor() {
        this.provider = "azure";
        this.group = "ops";
        this.workload = "ops";
      }
    }
    expect(assessAzureReleaseWorkloadIdentity(new WorkloadTarget())).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null });

    const throwingPrototype = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      getPrototypeOf() {
        throw new Error("prototype inspection failed");
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(throwingPrototype)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_provider_mismatch", "azure_group_missing", "azure_workload_missing"], identity: null });

    const throwingGroupDescriptor = new Proxy({ provider: "azure", group: "ops", workload: "ops" }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "group") {
          throw new Error("group descriptor inspection failed");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    expect(assessAzureReleaseWorkloadIdentity(throwingGroupDescriptor)).toStrictEqual({ status: "blocked", blockerCodes: ["azure_group_missing"], identity: null });
  });

  test("returns exact plain fresh sanitized objects", () => {
    const ordinaryInput = { provider: "azure", group: "ops", workload: "ops", metadata: { marker: "input-marker" } };
    const first = assessAzureReleaseWorkloadIdentity(ordinaryInput);
    const second = assessAzureReleaseWorkloadIdentity(ordinaryInput);
    expect(Object.keys(first)).toStrictEqual(["status", "blockerCodes", "identity"]);
    expect(Object.keys(first.identity)).toStrictEqual(["provider", "group", "workload"]);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(first.identity)).toBe(Object.prototype);
    expect(first).not.toBe(second);
    expect(first.identity).not.toBe(second.identity);
    expect(first.blockerCodes).not.toBe(second.blockerCodes);
    expect(first).not.toBe(ordinaryInput);
    expect(first.identity).not.toBe(ordinaryInput);
    expect(first.identity).not.toBe(ordinaryInput.metadata);

    first.status = "mutated";
    first.blockerCodes.push("mutated");
    first.identity.provider = "mutated";
    expect(assessAzureReleaseWorkloadIdentity(ordinaryInput)).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
    expect(ordinaryInput).toStrictEqual({ provider: "azure", group: "ops", workload: "ops", metadata: { marker: "input-marker" } });

    const nullPrototypeInput = Object.create(null);
    nullPrototypeInput.provider = "azure";
    nullPrototypeInput.group = "ops";
    nullPrototypeInput.workload = "ops";
    expect(assessAzureReleaseWorkloadIdentity(nullPrototypeInput)).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });

    const blockedFirst = assessAzureReleaseWorkloadIdentity({ provider: "aws", group: "ops", workload: "ops" });
    const blockedSecond = assessAzureReleaseWorkloadIdentity({ provider: "aws", group: "ops", workload: "ops" });
    expect(blockedFirst.identity).toBeNull();
    expect(blockedFirst.blockerCodes).not.toBe(blockedSecond.blockerCodes);
  });

  test("ignores and never returns unrelated sentinels", () => {
    const ignoredSymbol = Symbol("ignored-symbol-key");
    const input = {
      provider: "azure",
      group: "ops",
      workload: "ops",
      tenant: "top-tenant-sentinel",
      ignored: {
        credential: "nested-credential-sentinel",
        revision: "nested-revision-sentinel"
      },
      [ignoredSymbol]: "symbol-value-sentinel"
    };
    const result = assessAzureReleaseWorkloadIdentity(input);
    expect(result).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure", group: "ops", workload: "ops" } });
    const serialized = JSON.stringify(result);
    expect(serialized.includes("top-tenant-sentinel")).toBe(false);
    expect(serialized.includes("nested-credential-sentinel")).toBe(false);
    expect(serialized.includes("nested-revision-sentinel")).toBe(false);
    expect(serialized.includes("ignored-symbol-key")).toBe(false);
    expect(serialized.includes("symbol-value-sentinel")).toBe(false);
  });

  test("keeps production isolated and delegates exactly once", () => {
    expect(productionSource.match(/^import\s/mg)).toHaveLength(1);
    expect(productionSource.includes("./azure-release-provider-identity.mjs")).toBe(true);
    expect(productionSource.includes("target.provider")).toBe(false);
    expect(productionSource.includes("azure_provider_mismatch")).toBe(false);
    expect(productionSource.includes("import(")).toBe(false);
    expect(productionSource.includes("require(")).toBe(false);
    expect(productionSource.includes("process.")).toBe(false);
    expect(productionSource.includes("fetch(")).toBe(false);
    expect(productionSource.includes("console.")).toBe(false);
    expect(productionSource.includes("setTimeout(")).toBe(false);
    expect(productionSource.includes("child_process")).toBe(false);
    expect(productionSource.includes("runner")).toBe(false);
    expect(productionSource.includes("controlPlane")).toBe(false);
    expect(productionSource.includes("subscription")).toBe(false);
    expect(productionSource.includes("resourceGroup")).toBe(false);
    expect(productionSource.includes("revision")).toBe(false);
    expect(productionSource.includes("traffic")).toBe(false);
    const providerAssessorName = ["assessAzureRelease", "ProviderIdentity"].join("");
    const providerCallPattern = new RegExp(`${providerAssessorName}\\(target\\)`, "g");
    expect(productionSource.match(providerCallPattern)).toHaveLength(1);
  });
});
