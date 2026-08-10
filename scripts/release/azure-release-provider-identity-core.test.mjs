import { describe, test, expect } from "vitest";
import * as identityModule from "./azure-release-provider-identity.mjs";
import {
  AZURE_RELEASE_CONTRACT_STATUS,
  AZURE_RELEASE_PROVIDER_BLOCKER_CODE,
  assessAzureReleaseProviderIdentity
} from "./azure-release-provider-identity.mjs";

describe("Azure release provider identity core", () => {
  test("exact surface", () => {
    const exportsKeys = Object.keys(identityModule);
    expect(exportsKeys.length).toBe(3);
    expect(exportsKeys.includes("AZURE_RELEASE_CONTRACT_STATUS")).toBe(true);
    expect(exportsKeys.includes("AZURE_RELEASE_PROVIDER_BLOCKER_CODE")).toBe(true);
    expect(exportsKeys.includes("assessAzureReleaseProviderIdentity")).toBe(true);

    expect(Object.isFrozen(AZURE_RELEASE_CONTRACT_STATUS)).toBe(true);
    const statusKeys = Object.keys(AZURE_RELEASE_CONTRACT_STATUS);
    expect(statusKeys.length).toBe(2);
    expect(statusKeys[0]).toBe("READY");
    expect(statusKeys[1]).toBe("BLOCKED");
    expect(AZURE_RELEASE_CONTRACT_STATUS.READY).toBe("ready");
    expect(AZURE_RELEASE_CONTRACT_STATUS.BLOCKED).toBe("blocked");

    expect(Object.isFrozen(AZURE_RELEASE_PROVIDER_BLOCKER_CODE)).toBe(true);
    const blockerKeys = Object.keys(AZURE_RELEASE_PROVIDER_BLOCKER_CODE);
    expect(blockerKeys.length).toBe(1);
    expect(blockerKeys[0]).toBe("AZURE_PROVIDER_MISMATCH");
    expect(AZURE_RELEASE_PROVIDER_BLOCKER_CODE.AZURE_PROVIDER_MISMATCH).toBe("azure_provider_mismatch");
  });

  test("representative ready topology", () => {
    const ordinary = { provider: "azure" };
    const ordinaryExpected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    expect(assessAzureReleaseProviderIdentity(ordinary)).toStrictEqual(ordinaryExpected);

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "provider", {
      value: "azure",
      enumerable: false,
      writable: true,
      configurable: true
    });
    const nonEnumerableExpected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    expect(assessAzureReleaseProviderIdentity(nonEnumerable)).toStrictEqual(nonEnumerableExpected);

    const nullProto = Object.create(null);
    nullProto.provider = "azure";
    const nullProtoExpected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    expect(assessAzureReleaseProviderIdentity(nullProto)).toStrictEqual(nullProtoExpected);
  });

  test("representative provider rejection", () => {
    const missing = {};
    const missingExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(missing)).toStrictEqual(missingExpected);

    const empty = { provider: "" };
    const emptyExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(empty)).toStrictEqual(emptyExpected);

    const padded = { provider: " azure " };
    const paddedExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(padded)).toStrictEqual(paddedExpected);

    const whitespaceOnly = { provider: " " };
    const whitespaceOnlyExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(whitespaceOnly)).toStrictEqual(whitespaceOnlyExpected);

    const caseVariant = { provider: "Azure" };
    const caseVariantExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(caseVariant)).toStrictEqual(caseVariantExpected);

    const alternate = { provider: "aws" };
    const alternateExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(alternate)).toStrictEqual(alternateExpected);

    const nonString = { provider: 123 };
    const nonStringExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(nonString)).toStrictEqual(nonStringExpected);

    const inherited = Object.create({ provider: "azure" });
    const inheritedExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(inherited)).toStrictEqual(inheritedExpected);

    class ExampleClass {
      constructor() {
        this.provider = "azure";
      }
    }
    const instance = new ExampleClass();
    const instanceExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(instance)).toStrictEqual(instanceExpected);

    const customProto = Object.create({});
    customProto.provider = "azure";
    const customProtoExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(customProto)).toStrictEqual(customProtoExpected);
  });

  test("real call-boundary safety", () => {
    const zeroArgExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity()).toStrictEqual(zeroArgExpected);

    const undefinedExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(undefined)).toStrictEqual(undefinedExpected);

    const nullExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(null)).toStrictEqual(nullExpected);

    const stringExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity("azure")).toStrictEqual(stringExpected);

    const numberExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(1)).toStrictEqual(numberExpected);

    const booleanExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(true)).toStrictEqual(booleanExpected);

    const bigintExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(1n)).toStrictEqual(bigintExpected);

    const symbolExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(Symbol("test"))).toStrictEqual(symbolExpected);

    const funcExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(() => {})).toStrictEqual(funcExpected);
  });

  test("accessor safety", () => {
    let ownGetterCount = 0;
    const ownGetterTarget = {};
    Object.defineProperty(ownGetterTarget, "provider", {
      get() {
        ownGetterCount += 1;
        return "azure";
      }
    });
    const ownGetterExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(ownGetterTarget)).toStrictEqual(ownGetterExpected);
    expect(ownGetterCount).toBe(0);

    let ownSetterCount = 0;
    const ownSetterTarget = {};
    Object.defineProperty(ownSetterTarget, "provider", {
      set(value) {
        ownSetterCount += 1;
      }
    });
    const ownSetterExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(ownSetterTarget)).toStrictEqual(ownSetterExpected);
    expect(ownSetterCount).toBe(0);

    let inheritedGetterCount = 0;
    const inheritedGetterTarget = Object.create({
      get provider() {
        inheritedGetterCount += 1;
        return "azure";
      }
    });
    const inheritedGetterExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(inheritedGetterTarget)).toStrictEqual(inheritedGetterExpected);
    expect(inheritedGetterCount).toBe(0);
  });

  test("proxy safety (limitation: cannot detect transparent proxy exposing plain-object descriptors)", () => {
    const throwingGetPrototypeOf = new Proxy({ provider: "azure" }, {
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap");
      }
    });
    const throwingGetProtoExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(throwingGetPrototypeOf)).toStrictEqual(throwingGetProtoExpected);

    const throwingGetOwnPropertyDescriptor = new Proxy({ provider: "azure" }, {
      getOwnPropertyDescriptor(target, prop) {
        throw new Error("getOwnPropertyDescriptor trap");
      }
    });
    const throwingDescriptorExpected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(assessAzureReleaseProviderIdentity(throwingGetOwnPropertyDescriptor)).toStrictEqual(throwingDescriptorExpected);

    let unrelatedGetCount = 0;
    let unrelatedHasCount = 0;
    let unrelatedOwnKeysCount = 0;
    const unrelatedTrapsTarget = new Proxy({ provider: "azure" }, {
      get(target, prop, receiver) {
        unrelatedGetCount += 1;
        throw new Error("get trap");
      },
      has(target, prop) {
        unrelatedHasCount += 1;
        throw new Error("has trap");
      },
      ownKeys(target) {
        unrelatedOwnKeysCount += 1;
        throw new Error("ownKeys trap");
      }
    });
    const unrelatedTrapsExpected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    expect(assessAzureReleaseProviderIdentity(unrelatedTrapsTarget)).toStrictEqual(unrelatedTrapsExpected);
    expect(unrelatedGetCount).toBe(0);
    expect(unrelatedHasCount).toBe(0);
    expect(unrelatedOwnKeysCount).toBe(0);
  });

  test("exact structure, freshness, and non-aliasing", () => {
    const readyInput = { provider: "azure" };
    const readyResult1 = assessAzureReleaseProviderIdentity(readyInput);
    const readyResult2 = assessAzureReleaseProviderIdentity(readyInput);

    expect(readyResult1).not.toBe(readyResult2);
    expect(readyResult1.identity).not.toBe(readyResult2.identity);
    expect(readyResult1.blockerCodes).not.toBe(readyResult2.blockerCodes);
    expect(readyResult1.identity).not.toBe(readyInput);

    expect(Object.getPrototypeOf(readyResult1)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(readyResult1.identity)).toBe(Object.prototype);
    expect(Array.isArray(readyResult1.blockerCodes)).toBe(true);

    const readyKeys = Object.keys(readyResult1);
    expect(readyKeys[0]).toBe("status");
    expect(readyKeys[1]).toBe("blockerCodes");
    expect(readyKeys[2]).toBe("identity");
    expect(Object.keys(readyResult1.identity)).toEqual(["provider"]);

    readyResult1.identity.provider = "mutated";
    readyResult1.blockerCodes.push("mutated");
    const readyResult3 = assessAzureReleaseProviderIdentity(readyInput);
    const readyResult3Expected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    expect(readyResult3).toStrictEqual(readyResult3Expected);
    expect(readyInput.provider).toBe("azure");

    const blockedInput = { provider: "aws", unrelated: { marker: "blocked-input-marker" } };
    const blockedInputKeys = Object.keys(blockedInput);
    const unrelatedRef = blockedInput.unrelated;
    const blockedResult1 = assessAzureReleaseProviderIdentity(blockedInput);
    const blockedResult2 = assessAzureReleaseProviderIdentity(blockedInput);

    expect(blockedResult1).not.toBe(blockedResult2);
    expect(blockedResult1.blockerCodes).not.toBe(blockedResult2.blockerCodes);
    expect(blockedResult1).not.toBe(blockedInput);
    expect(blockedResult1.blockerCodes).not.toBe(unrelatedRef);

    expect(Object.getPrototypeOf(blockedResult1)).toBe(Object.prototype);
    expect(Array.isArray(blockedResult1.blockerCodes)).toBe(true);

    const blockedKeys = Object.keys(blockedResult1);
    expect(blockedKeys[0]).toBe("status");
    expect(blockedKeys[1]).toBe("blockerCodes");
    expect(blockedKeys[2]).toBe("identity");

    blockedResult1.status = "mutated";
    blockedResult1.blockerCodes.push("mutated");
    expect(Object.keys(blockedInput)).toStrictEqual(blockedInputKeys);
    expect(blockedInput.provider).toBe("aws");
    expect(blockedInput.unrelated.marker).toBe("blocked-input-marker");
    expect(blockedInput.unrelated).toBe(unrelatedRef);
    const blockedResult3 = assessAzureReleaseProviderIdentity(blockedInput);
    const blockedResult3Expected = { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null };
    expect(blockedResult3).toStrictEqual(blockedResult3Expected);
  });

  test("basic unknown non-escape", () => {
    const symbolKey = Symbol("testSymbol");
    const input = {
      provider: "azure",
      topLevelUnknown: "topValue",
      nestedObj: {
        nestedUnknown: "nestedValue"
      },
      [symbolKey]: "symbolValue"
    };
    const expected = {
      status: "ready",
      blockerCodes: [],
      identity: { provider: "azure" }
    };
    const result = assessAzureReleaseProviderIdentity(input);
    expect(result).toStrictEqual(expected);

    const serialized = JSON.stringify(result);
    expect(serialized.includes("topLevelUnknown")).toBe(false);
    expect(serialized.includes("topValue")).toBe(false);
    expect(serialized.includes("nestedObj")).toBe(false);
    expect(serialized.includes("nestedUnknown")).toBe(false);
    expect(serialized.includes("nestedValue")).toBe(false);
    expect(serialized.includes("testSymbol")).toBe(false);
    expect(serialized.includes("symbolValue")).toBe(false);
  });
});
