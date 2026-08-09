import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { assessAzureReleaseProviderIdentity } from "./azure-release-provider-identity.mjs";

class ValidLookingProviderTarget {
  constructor() {
    this.provider = "azure";
  }
}

const productionSource = readFileSync(new URL("./azure-release-provider-identity.mjs", import.meta.url), "utf8");
const staticImportMatcher = /\bimport(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*(?=["{*]|[A-Za-z_$])/;
const namedReExportMatcher = /\bexport(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*\{[\s\S]*?\}(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*from(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*(?=")/;
const starReExportMatcher = /\bexport(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*\*(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*from(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*(?=")/;
const dynamicImportMatcher = /\bimport(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*\(/;
const requireMatcher = /\brequire(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*\(/;
const processMatcher = /\bprocess(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*(?=\.|\?\.|\[)/;
const fetchMatcher = /\bfetch(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*\(/;
const consoleMatcher = /\bconsole(?:[ \t\r\n]|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\n))*(?=\.|\?\.|\[)/;

describe("Azure release provider identity hardening", () => {
  test("rejects the exact own-provider malformed matrix", () => {
    const rows = [
      { name: "undefined", target: { provider: undefined }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "null", target: { provider: null }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "true", target: { provider: true }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "false", target: { provider: false }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "zero", target: { provider: 0 }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "one", target: { provider: 1 }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "negative-one", target: { provider: -1 }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "nan", target: { provider: NaN }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "positive-infinity", target: { provider: Infinity }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "negative-infinity", target: { provider: -Infinity }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "bigint", target: { provider: 1n }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "symbol", target: { provider: Symbol("provider-symbol") }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "function", target: { provider: () => {} }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "empty-array", target: { provider: [] }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "populated-array", target: { provider: ["azure"] }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "plain-object", target: { provider: {} }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "date", target: { provider: new Date(0) }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "map", target: { provider: new Map() }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "set", target: { provider: new Set() }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "regex", target: { provider: /azure/ }, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } }
    ];

    expect(rows).toHaveLength(20);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(20);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseProviderIdentity(target)).toStrictEqual(expected);
    }
  });

  test("rejects the exact top-level malformed matrix", () => {
    const customPrototypeTarget = Object.create({ marker: "custom-prototype-base" });
    customPrototypeTarget.provider = "azure";
    const inheritedOnlyProviderTarget = Object.create({ provider: "azure" });
    const rows = [
      { name: "undefined", target: undefined, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "null", target: null, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "true", target: true, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "false", target: false, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "zero", target: 0, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "one", target: 1, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "negative-one", target: -1, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "nan", target: NaN, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "positive-infinity", target: Infinity, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "negative-infinity", target: -Infinity, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "bigint", target: 1n, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "symbol", target: Symbol("target-symbol"), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "string", target: "azure", expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "function", target: () => {}, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "empty-array", target: [], expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "populated-array", target: ["azure"], expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "date", target: new Date(0), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "map", target: new Map(), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "set", target: new Set(), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "regex", target: /azure/, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "class-instance", target: new ValidLookingProviderTarget(), expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "custom-prototype", target: customPrototypeTarget, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } },
      { name: "inherited-only-provider", target: inheritedOnlyProviderTarget, expected: { status: "blocked", blockerCodes: ["azure_provider_mismatch"], identity: null } }
    ];

    expect(rows).toHaveLength(23);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(23);
    for (const { target, expected } of rows) {
      expect(assessAzureReleaseProviderIdentity(target)).toStrictEqual(expected);
    }
  });

  test("never returns any locked ignored sentinel", () => {
    const topSymbolKey = Symbol("topIgnoredSymbol");
    const nestedSymbolKey = Symbol("nestedIgnoredSymbol");
    const sentinelFixture = {
      group: "safe-marker-01-top",
      workload: "safe-marker-02-top",
      azure: "safe-marker-03-top",
      subscriptionId: "safe-marker-04-top",
      resourceGroup: "safe-marker-05-top",
      acrName: "safe-marker-06-top",
      acrServer: "safe-marker-07-top",
      webAppName: "safe-marker-08-top",
      workerAppName: "safe-marker-09-top",
      applicationInsightsConnectionString: "safe-marker-10-top",
      runtimeOrigin: "safe-marker-11-top",
      url: "safe-marker-12-top",
      image: "safe-marker-13-top",
      digest: "safe-marker-14-top",
      revision: "safe-marker-15-top",
      action: "safe-marker-16-top",
      operation: "safe-marker-17-top",
      credential: "aaaaaaaaaaaaaaaaaaaa",
      secret: "bbbbbbbbbbbbbbbbbbbb",
      unknownFutureKey: "cccccccccccccccccccc",
      ignored: {
        group: "safe-marker-21-nested",
        workload: "safe-marker-22-nested",
        azure: "safe-marker-23-nested",
        subscriptionId: "safe-marker-24-nested",
        resourceGroup: "safe-marker-25-nested",
        acrName: "safe-marker-26-nested",
        acrServer: "safe-marker-27-nested",
        webAppName: "safe-marker-28-nested",
        workerAppName: "safe-marker-29-nested",
        applicationInsightsConnectionString: "safe-marker-30-nested",
        runtimeOrigin: "safe-marker-31-nested",
        url: "safe-marker-32-nested",
        image: "safe-marker-33-nested",
        digest: "safe-marker-34-nested",
        revision: "safe-marker-35-nested",
        action: "safe-marker-36-nested",
        operation: "safe-marker-37-nested",
        credential: "dddddddddddddddddddd",
        secret: "eeeeeeeeeeeeeeeeeeee",
        unknownFutureKey: "ffffffffffffffffffff",
        [nestedSymbolKey]: "safe-marker-42-nested-symbol"
      },
      [topSymbolKey]: "safe-marker-41-top-symbol"
    };
    const markerValues = [
      ...Object.values(sentinelFixture).filter((value) => typeof value === "string"),
      ...Object.values(sentinelFixture.ignored),
      sentinelFixture[topSymbolKey],
      sentinelFixture.ignored[nestedSymbolKey]
    ];

    expect(Reflect.ownKeys(sentinelFixture)).toHaveLength(22);
    expect(Reflect.ownKeys(sentinelFixture.ignored)).toHaveLength(21);
    expect(markerValues).toHaveLength(42);
    expect(new Set(markerValues).size).toBe(42);
    expect(topSymbolKey.description).not.toBe(nestedSymbolKey.description);

    const providerFirstResult = assessAzureReleaseProviderIdentity({ provider: "azure", ...sentinelFixture });
    expect(providerFirstResult).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure" } });
    const providerLastResult = assessAzureReleaseProviderIdentity({ ...sentinelFixture, provider: "azure" });
    expect(providerLastResult).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure" } });
    const providerOnlyResult = assessAzureReleaseProviderIdentity({ provider: "azure" });
    expect(providerOnlyResult).toStrictEqual({ status: "ready", blockerCodes: [], identity: { provider: "azure" } });

    const results = [providerFirstResult, providerLastResult, providerOnlyResult];
    for (const result of results) {
      expect(Object.keys(result)).toStrictEqual(["status", "blockerCodes", "identity"]);
      expect(Object.keys(result.identity)).toStrictEqual(["provider"]);
    }
    const serializedResults = results.map((result) => JSON.stringify(result));
    for (const serializedResult of serializedResults) {
      for (const markerValue of markerValues) {
        expect(serializedResult.includes(markerValue)).toBe(false);
      }
      expect(serializedResult.includes(topSymbolKey.description)).toBe(false);
      expect(serializedResult.includes(nestedSymbolKey.description)).toBe(false);
    }
  });

  test("keeps production source statically isolated", () => {
    expect(staticImportMatcher.global).toBe(false);
    expect(staticImportMatcher.sticky).toBe(false);
    expect(namedReExportMatcher.global).toBe(false);
    expect(namedReExportMatcher.sticky).toBe(false);
    expect(starReExportMatcher.global).toBe(false);
    expect(starReExportMatcher.sticky).toBe(false);
    expect(dynamicImportMatcher.global).toBe(false);
    expect(dynamicImportMatcher.sticky).toBe(false);
    expect(requireMatcher.global).toBe(false);
    expect(requireMatcher.sticky).toBe(false);
    expect(processMatcher.global).toBe(false);
    expect(processMatcher.sticky).toBe(false);
    expect(fetchMatcher.global).toBe(false);
    expect(fetchMatcher.sticky).toBe(false);
    expect(consoleMatcher.global).toBe(false);
    expect(consoleMatcher.sticky).toBe(false);

    expect(staticImportMatcher.test(productionSource)).toBe(false);
    expect(namedReExportMatcher.test(productionSource)).toBe(false);
    expect(starReExportMatcher.test(productionSource)).toBe(false);
    expect(dynamicImportMatcher.test(productionSource)).toBe(false);
    expect(requireMatcher.test(productionSource)).toBe(false);
    expect(processMatcher.test(productionSource)).toBe(false);
    expect(fetchMatcher.test(productionSource)).toBe(false);
    expect(consoleMatcher.test(productionSource)).toBe(false);
  });

  test("binds every required positive fixture to its intended matcher", () => {
    const rows = [
      { name: "static-import-no-space", matcher: staticImportMatcher, source: "import\"./module.mjs\";" },
      { name: "static-import-whitespace", matcher: staticImportMatcher, source: "import \"./module.mjs\";" },
      { name: "static-import-block-comment", matcher: staticImportMatcher, source: "import/*gap*/\"./module.mjs\";" },
      { name: "static-import-line-comment-lf", matcher: staticImportMatcher, source: "import//gap\n\"./module.mjs\";" },
      { name: "static-import-line-comment-crlf", matcher: staticImportMatcher, source: "import//gap\r\n\"./module.mjs\";" },
      { name: "static-import-keyword-eol", matcher: staticImportMatcher, source: "import\n\"./module.mjs\";" },
      { name: "named-reexport-no-space", matcher: namedReExportMatcher, source: "export{ value }from\"./module.mjs\";" },
      { name: "named-reexport-whitespace", matcher: namedReExportMatcher, source: "export { value } from \"./module.mjs\";" },
      { name: "named-reexport-block-comment", matcher: namedReExportMatcher, source: "export/*gap*/{ value }from\"./module.mjs\";" },
      { name: "named-reexport-line-comment-lf", matcher: namedReExportMatcher, source: "export//gap\n{ value }from\"./module.mjs\";" },
      { name: "named-reexport-line-comment-crlf", matcher: namedReExportMatcher, source: "export//gap\r\n{ value }from\"./module.mjs\";" },
      { name: "named-reexport-keyword-eol", matcher: namedReExportMatcher, source: "export\n{ value }from\"./module.mjs\";" },
      { name: "star-reexport-no-space", matcher: starReExportMatcher, source: "export*from\"./module.mjs\";" },
      { name: "star-reexport-whitespace", matcher: starReExportMatcher, source: "export * from \"./module.mjs\";" },
      { name: "star-reexport-block-comment", matcher: starReExportMatcher, source: "export/*gap*/*from\"./module.mjs\";" },
      { name: "star-reexport-line-comment-lf", matcher: starReExportMatcher, source: "export//gap\n*from\"./module.mjs\";" },
      { name: "star-reexport-line-comment-crlf", matcher: starReExportMatcher, source: "export//gap\r\n*from\"./module.mjs\";" },
      { name: "star-reexport-keyword-eol", matcher: starReExportMatcher, source: "export\n*from\"./module.mjs\";" },
      { name: "dynamic-import-direct", matcher: dynamicImportMatcher, source: "const value = import(\"./module.mjs\");" },
      { name: "dynamic-import-whitespace", matcher: dynamicImportMatcher, source: "const value = import (\"./module.mjs\");" },
      { name: "dynamic-import-block-comment", matcher: dynamicImportMatcher, source: "const value = import/*gap*/(\"./module.mjs\");" },
      { name: "dynamic-import-line-comment-lf", matcher: dynamicImportMatcher, source: "const value = import//gap\n(\"./module.mjs\");" },
      { name: "dynamic-import-line-comment-crlf", matcher: dynamicImportMatcher, source: "const value = import//gap\r\n(\"./module.mjs\");" },
      { name: "dynamic-import-midexpression-block", matcher: dynamicImportMatcher, source: "value = import/*gap*/(\"./module.mjs\");" },
      { name: "dynamic-import-midexpression-lf", matcher: dynamicImportMatcher, source: "value = import//gap\n(\"./module.mjs\");" },
      { name: "dynamic-import-midexpression-crlf", matcher: dynamicImportMatcher, source: "value = import//gap\r\n(\"./module.mjs\");" },
      { name: "require-direct", matcher: requireMatcher, source: "const value = require(\"module\");" },
      { name: "require-whitespace", matcher: requireMatcher, source: "const value = require (\"module\");" },
      { name: "require-block-comment", matcher: requireMatcher, source: "const value = require/*gap*/(\"module\");" },
      { name: "require-line-comment-lf", matcher: requireMatcher, source: "const value = require//gap\n(\"module\");" },
      { name: "require-line-comment-crlf", matcher: requireMatcher, source: "const value = require//gap\r\n(\"module\");" },
      { name: "process-direct", matcher: processMatcher, source: "const value = process.env;" },
      { name: "process-whitespace", matcher: processMatcher, source: "const value = process .env;" },
      { name: "process-block-comment", matcher: processMatcher, source: "const value = process/*gap*/.env;" },
      { name: "process-line-comment-lf", matcher: processMatcher, source: "const value = process//gap\n.env;" },
      { name: "process-line-comment-crlf", matcher: processMatcher, source: "const value = process//gap\r\n.env;" },
      { name: "fetch-direct", matcher: fetchMatcher, source: "const value = fetch(\"https://example.invalid\");" },
      { name: "fetch-whitespace", matcher: fetchMatcher, source: "const value = fetch (\"https://example.invalid\");" },
      { name: "fetch-block-comment", matcher: fetchMatcher, source: "const value = fetch/*gap*/(\"https://example.invalid\");" },
      { name: "fetch-line-comment-lf", matcher: fetchMatcher, source: "const value = fetch//gap\n(\"https://example.invalid\");" },
      { name: "fetch-line-comment-crlf", matcher: fetchMatcher, source: "const value = fetch//gap\r\n(\"https://example.invalid\");" },
      { name: "console-direct", matcher: consoleMatcher, source: "console.log(\"value\");" },
      { name: "console-whitespace", matcher: consoleMatcher, source: "console .log(\"value\");" },
      { name: "console-block-comment", matcher: consoleMatcher, source: "console/*gap*/.log(\"value\");" },
      { name: "console-line-comment-lf", matcher: consoleMatcher, source: "console//gap\n.log(\"value\");" },
      { name: "console-line-comment-crlf", matcher: consoleMatcher, source: "console//gap\r\n.log(\"value\");" }
    ];

    expect(new Set(rows.map(({ name }) => name)).size).toBe(rows.length);
    for (const { matcher, source } of rows) {
      expect(matcher.test(source)).toBe(true);
    }
  });

  test("binds every required negative fixture to its relevant matcher", () => {
    expect(namedReExportMatcher.test("export const value = 1;")).toBe(false);
    expect(starReExportMatcher.test("export const value = 1;")).toBe(false);
    expect(namedReExportMatcher.test("export function value() {}")).toBe(false);
    expect(starReExportMatcher.test("export function value() {}")).toBe(false);
    expect(staticImportMatcher.test("const value = import.meta.url;")).toBe(false);
    expect(dynamicImportMatcher.test("const value = import.meta.url;")).toBe(false);
    expect(requireMatcher.test("const requirement = true;")).toBe(false);
    expect(processMatcher.test("const processor = {};")).toBe(false);
    expect(fetchMatcher.test("const prefetch = true;")).toBe(false);
    expect(consoleMatcher.test("const consoleValue = true;")).toBe(false);
  });

  test("has exactly the four locked tracked callers", () => {
    const output = execFileSync("git", ["grep", "-l", "assessAzureReleaseProviderIdentity"], {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8"
    });
    const paths = output.trim().split("\n").sort();
    expect(paths).toStrictEqual([
      "scripts/release/azure-release-provider-identity-core.test.mjs",
      "scripts/release/azure-release-provider-identity-hardening.test.mjs",
      "scripts/release/azure-release-provider-identity.mjs",
      "scripts/release/azure-release-workload-identity.mjs"
    ]);
  });
});
