import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { createSourceIsolationImportKernel } from "./azure-release-test-source-isolation.test-helper.mjs";

const findingCodes = [
  "IMPORT_FORBIDDEN",
  "IMPORT_DYNAMIC",
  "ACQUISITION_DANGEROUS",
  "CALLABLE_DANGEROUS",
  "NAME_UNRESOLVED",
  "FLOW_AMBIGUOUS",
  "FLOW_UNSUPPORTED"
];
const capabilities = ["finding-schema", "static-imports", "dynamic-imports"];
const fixtureFamilies = ["import-exact", "import-dynamic"];
const fixtureNames = ["import-exact-safe", "import-exact-unsafe", "import-meta-safe", "import-dynamic-unsafe"];
const policy = {
  permittedImports: [
    { module: "side-effect", bindings: [] },
    { module: "namespace-only", bindings: ["namespace=namespaceValue"] },
    { module: "named-only", bindings: ["named:safe=safe", "named:for=forValue", "named:default=defaultValue2"] },
    { module: "default-only", bindings: ["default=defaultValue"] }
  ]
};
function freezeFixture(row) {
  Object.freeze(row.expectedFindings);
  return Object.freeze(row);
}

const fixtures = Object.freeze([
  freezeFixture({
    name: "import-exact-safe",
    family: "import-exact",
    source: "import \"side-effect\";\nimport defaultValue from \"default-only\";\nimport * as namespaceValue from \"namespace-only\";\nimport { default as defaultValue2, for as forValue, safe } from \"named-only\";\n",
    expectedFindings: []
  }),
  freezeFixture({
    name: "import-exact-unsafe",
    family: "import-exact",
    source: "import sideEffectValue from \"side-effect\";\nimport defaultValue from \"default-only\";\nimport duplicateDefault from \"default-only\";\nimport attributeDefault from \"default-only\" with { type: \"json\" };\nexport * as wrongNamespace from \"namespace-only\";\nimport { default as wrongDefault, for as wrongFor, safe as wrongSafe } from \"named-only\";\nimport \"named-only\";\nimport \"extra-module\";\nimport {} from \"side-effect\";\nimport \"side-effect\";\nimport \"side-effect\";\n",
    expectedFindings: [
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 1, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "SourceFile", line: 1, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 3, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 4, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ExportDeclaration", line: 5, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 6, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 7, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 8, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 9, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 11, column: 1 }
    ]
  }),
  freezeFixture({
    name: "import-meta-safe",
    family: "import-dynamic",
    source: "import \"side-effect\";\nimport defaultValue from \"default-only\";\nimport * as namespaceValue from \"namespace-only\";\nimport { default as defaultValue2, for as forValue, safe } from \"named-only\";\nconst meta = import.meta;\n",
    expectedFindings: []
  }),
  freezeFixture({
    name: "import-dynamic-unsafe",
    family: "import-dynamic",
    source: "import \"side-effect\";\nimport defaultValue from \"default-only\";\nimport * as namespaceValue from \"namespace-only\";\nimport { default as defaultValue2, for as forValue, safe } from \"named-only\";\nconst first = import(\"dynamic-one\");\nconst load = () => import(\"dynamic-two\");\n",
    expectedFindings: [
      { code: "IMPORT_DYNAMIC", node: "CallExpression", line: 5, column: 15 },
      { code: "IMPORT_DYNAMIC", node: "CallExpression", line: 6, column: 20 }
    ]
  })
]);

const compareFindings = (left, right) => left.line - right.line || left.column - right.column || left.code.localeCompare(right.code) || left.node.localeCompare(right.node);

describe("source-isolation import kernel", () => {
  test("validates, normalizes, and clones policy", () => {
    const mutablePolicy = { permittedImports: [{ module: "keywords", bindings: ["named:for=forValue", "named:default=defaultValue"] }] };
    const kernel = createSourceIsolationImportKernel(mutablePolicy);
    mutablePolicy.permittedImports[0].bindings.length = 0;
    mutablePolicy.permittedImports.length = 0;
    const source = `import { default as defaultValue, for as forValue } from "keywords";`;
    expect(kernel.inspect(source)).toStrictEqual({ phase: "imports", complete: false, capabilities, findings: [] });
    const rejectedPolicies = [
      null,
      1,
      "invalid",
      [],
      {},
      { permittedImports: "invalid" },
      { permittedImports: [], extra: true },
      { permittedImports: [{}] },
      { permittedImports: [1] },
      { permittedImports: [[]] },
      { permittedImports: [{ module: "", bindings: [] }] },
      { permittedImports: [{ module: 1, bindings: [] }] },
      { permittedImports: [{ module: "module", bindings: "invalid" }] },
      { permittedImports: [{ module: "module", bindings: [1] }] },
      { permittedImports: [{ module: "module", bindings: [""] }] },
      { permittedImports: [{ module: "module", bindings: ["invalid"] }] },
      { permittedImports: [{ module: "module", bindings: ["named:not-valid=local"] }] },
      { permittedImports: [{ module: "module", bindings: ["named:safe=for"] }] },
      { permittedImports: [{ module: "module", bindings: ["default=default"] }] },
      { permittedImports: [{ module: "module", bindings: ["namespace=await"] }] },
      { permittedImports: [{ module: "module", bindings: ["named:safe=local", "named:safe=local"] }] },
      { permittedImports: [{ module: "module", bindings: [] }, { module: "module", bindings: [] }] },
      { permittedImports: [{ module: "module", bindings: [], extra: true }] }
    ];
    for (const rejectedPolicy of rejectedPolicies) {
      expect(() => createSourceIsolationImportKernel(rejectedPolicy)).toThrow(TypeError);
    }
    expect(() => kernel.inspect(null)).toThrow(TypeError);
    expect(() => kernel.inspect("const value = ;")).toThrow(SyntaxError);
    const phasedKernel = createSourceIsolationImportKernel({ permittedImports: [{ module: "module", bindings: ["namespace=value"] }] });
    expect(phasedKernel.inspect('import defer * as value from "module";').findings).toStrictEqual([
      { code: "IMPORT_FORBIDDEN", node: "ImportDeclaration", line: 1, column: 1 },
      { code: "IMPORT_FORBIDDEN", node: "SourceFile", line: 1, column: 1 }
    ]);
  });

  test("binds and executes the exact frozen fixture contract", () => {
    expect(findingCodes).toStrictEqual(["IMPORT_FORBIDDEN", "IMPORT_DYNAMIC", "ACQUISITION_DANGEROUS", "CALLABLE_DANGEROUS", "NAME_UNRESOLVED", "FLOW_AMBIGUOUS", "FLOW_UNSUPPORTED"]);
    expect(new Set(findingCodes).size).toBe(7);
    expect(fixtures.map(({ family }) => family)).toStrictEqual(["import-exact", "import-exact", "import-dynamic", "import-dynamic"]);
    expect(fixtures.map(({ name }) => name)).toStrictEqual(fixtureNames);
    expect([...new Set(fixtures.map(({ family }) => family))]).toStrictEqual(fixtureFamilies);
    expect(new Set(fixtures.map(({ name }) => name)).size).toBe(4);
    expect(Object.isFrozen(fixtures)).toBe(true);
    expect(fixtures.map((fixture) => Object.isFrozen(fixture))).toStrictEqual([true, true, true, true]);
    expect(fixtures.map(({ expectedFindings }) => Object.isFrozen(expectedFindings))).toStrictEqual([true, true, true, true]);
    const testSource = ts.createSourceFile("fixture-test.mjs", readFileSync(new URL(import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const fixtureDeclaration = testSource.statements.flatMap((statement) => ts.isVariableStatement(statement) ? statement.declarationList.declarations : []).find((declaration) => declaration.name.getText(testSource) === "fixtures");
    const fixtureRows = fixtureDeclaration.initializer.arguments[0].elements;
    const sourceInitializers = fixtureRows.map((row) => row.arguments[0].properties.find((property) => property.name.getText(testSource) === "source").initializer);
    expect(sourceInitializers.every((initializer) => ts.isStringLiteralLike(initializer))).toBe(true);
    expect(fixtures.map(({ expectedFindings }) => expectedFindings.length)).toStrictEqual([0, 10, 0, 2]);
    const usedCodes = [...new Set(fixtures.flatMap(({ expectedFindings }) => expectedFindings.map(({ code }) => code)))].sort();
    expect(usedCodes).toStrictEqual(["IMPORT_DYNAMIC", "IMPORT_FORBIDDEN"]);
    const kernel = createSourceIsolationImportKernel(policy);
    for (const fixture of fixtures) {
      execFileSync(process.execPath, ["--check", "--input-type=module"], { input: fixture.source });
      const keys = fixture.expectedFindings.map((finding) => Object.keys(finding));
      expect(keys).toStrictEqual(fixture.expectedFindings.map(() => ["code", "node", "line", "column"]));
      expect(fixture.expectedFindings).toStrictEqual([...fixture.expectedFindings].sort(compareFindings));
      const result = kernel.inspect(fixture.source);
      expect(result).toStrictEqual({ phase: "imports", complete: false, capabilities, findings: fixture.expectedFindings });
      expect(result.findings).toStrictEqual(fixture.expectedFindings);
    }
  });
});
