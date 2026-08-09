import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const productionSource = readFileSync(new URL("./azure-release-workload-identity.mjs", import.meta.url), "utf8");
const testSource = readFileSync(new URL(import.meta.url), "utf8");
const providerAssessorName = ["assessAzureRelease", "ProviderIdentity"].join("");
const workloadAssessorName = ["assessAzureRelease", "WorkloadIdentity"].join("");
const statusName = "AZURE_RELEASE_CONTRACT_STATUS";
const providerModule = "./azure-release-provider-identity.mjs";
const workloadModule = "./azure-release-workload-identity.mjs";
const apostrophe = String.fromCharCode(39);
const templateQuote = String.fromCharCode(96);
const permittedImport = "import { " + statusName + ", " + providerAssessorName + " } from \"" + providerModule + "\";";
const permittedExport = "export { " + statusName + " };";
const canonicalSource = permittedImport + "\n" + permittedExport;
const expectedImportBindings = [providerAssessorName + "=" + providerAssessorName, statusName + "=" + statusName].sort();
const expectedExportBindings = [statusName + "=" + statusName];
const allowedSelfImportSources = ["node:child_process", "node:fs", "typescript", "vitest"].sort();
const permittedSelfImports = [
  "import { execFileSync } from \"node:child_process\";",
  "import { readFileSync } from \"node:fs\";",
  "import ts from \"typescript\";",
  "import { describe, expect, test } from \"vitest\";"
].join("\n");

function parseSource(source) {
  return ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
}

function namedBindingSignature(clause) {
  if (!clause || (!ts.isNamedImports(clause) && !ts.isNamedExports(clause))) return null;
  if (clause.elements.some((element) => element.propertyName)) return null;
  return clause.elements.map((element) => {
    return element.name.text + "=" + element.name.text;
  }).sort();
}

function bindingsEqual(actual, expected) {
  return actual !== null && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function containsDynamicImport(file) {
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function containsDefaultExport(file) {
  return file.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true;
    return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
  });
}

function isAssessorCallTarget(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text === providerAssessorName || expression.text === workloadAssessorName;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === providerAssessorName || expression.name.text === workloadAssessorName;
  }
  if (!ts.isElementAccessExpression(expression)) return false;
  const argument = expression.argumentExpression;
  if (ts.isStringLiteral(argument)) {
    return argument.text === providerAssessorName || argument.text === workloadAssessorName;
  }
  if (!ts.isIdentifier(argument)) return false;
  return argument.text === "providerAssessorName" || argument.text === "workloadAssessorName";
}

function containsAssessorCall(file) {
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && isAssessorCallTarget(node.expression)) found = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function selfSourceIsExact(source) {
  const file = parseSource(source);
  const imports = file.statements.filter(ts.isImportDeclaration);
  if (imports.length !== 4 || containsDynamicImport(file) || containsAssessorCall(file)) return false;
  if (imports.some((declaration) => !ts.isStringLiteral(declaration.moduleSpecifier))) return false;
  const sources = imports.map((declaration) => declaration.moduleSpecifier.text).sort();
  return bindingsEqual(sources, allowedSelfImportSources);
}

function moduleSurfaceIsExact(source) {
  const file = parseSource(source);
  const imports = file.statements.filter(ts.isImportDeclaration);
  const exports = file.statements.filter(ts.isExportDeclaration);
  if (imports.length !== 1 || exports.length !== 1 || containsDynamicImport(file) || containsDefaultExport(file)) return false;

  const importDeclaration = imports[0];
  const exportDeclaration = exports[0];
  const importClause = importDeclaration.importClause;
  const importBindings = namedBindingSignature(importClause?.namedBindings);
  const exportBindings = namedBindingSignature(exportDeclaration.exportClause);

  if (!ts.isStringLiteral(importDeclaration.moduleSpecifier)) return false;
  if (importDeclaration.moduleSpecifier.text !== providerModule) return false;
  if (!importClause || importClause.name || !ts.isNamedImports(importClause.namedBindings)) return false;
  if (importDeclaration.attributes || importDeclaration.assertClause) return false;
  if (!bindingsEqual(importBindings, expectedImportBindings)) return false;
  if (exportDeclaration.moduleSpecifier || !ts.isNamedExports(exportDeclaration.exportClause)) return false;
  return bindingsEqual(exportBindings, expectedExportBindings);
}

function syntaxCheck(source) {
  execFileSync(process.execPath, ["--check", "--input-type=module"], { input: source });
}

const fixtureNames = [
  "canonical",
  "reversed-bindings",
  "spaced",
  "tabbed",
  "block-comments",
  "lf-comments",
  "crlf-comments",
  "asi",
  "double-quoted",
  "single-quoted",
  "wrong-source",
  "missing-status",
  "missing-assessor",
  "status-alias",
  "status-redundant-alias",
  "assessor-alias",
  "assessor-redundant-alias",
  "third-binding",
  "default-import",
  "namespace-import",
  "side-effect-import",
  "second-import",
  "same-line-import-after-block",
  "comment-decoy",
  "string-decoy",
  "template-decoy",
  "export-alias",
  "export-redundant-alias",
  "export-extra-binding",
  "second-export-block",
  "named-source-reexport",
  "star-source-reexport",
  "namespace-source-reexport",
  "default-export-expression",
  "default-export-function",
  "default-export-class",
  "same-line-reexport-after-block",
  "exported-variable",
  "exported-function",
  "exported-class",
  "import-meta",
  "dynamic-import"
];

const fixtures = [
  { name: "canonical", family: "import", source: canonicalSource, expected: true },
  { name: "reversed-bindings", family: "import", source: "import { " + providerAssessorName + ", " + statusName + " } from \"" + providerModule + "\";\n" + permittedExport, expected: true },
  { name: "spaced", family: "import", source: "import  {  " + statusName + "  ,  " + providerAssessorName + "  }  from  \"" + providerModule + "\"  ;\n" + permittedExport, expected: true },
  { name: "tabbed", family: "import", source: "import\t{\t" + statusName + "\t,\t" + providerAssessorName + "\t}\tfrom\t\"" + providerModule + "\"\t;\n" + permittedExport, expected: true },
  { name: "block-comments", family: "import", source: "import/*a*/{/*b*/" + statusName + "/*c*/,/*d*/" + providerAssessorName + "/*e*/}/*f*/from/*g*/\"" + providerModule + "\";\n" + permittedExport, expected: true },
  { name: "lf-comments", family: "import", source: "import//a\n{//b\n" + statusName + ",//c\n" + providerAssessorName + "//d\n}//e\nfrom//f\n\"" + providerModule + "\";\n" + permittedExport, expected: true },
  { name: "crlf-comments", family: "import", source: "import//a\r\n{//b\r\n" + statusName + ",//c\r\n" + providerAssessorName + "//d\r\n}//e\r\nfrom//f\r\n\"" + providerModule + "\";\r\n" + permittedExport, expected: true },
  { name: "asi", family: "import", source: permittedImport.slice(0, -1) + "\n" + permittedExport.slice(0, -1), expected: true },
  { name: "double-quoted", family: "import", source: permittedImport + "\n" + permittedExport, expected: true },
  { name: "single-quoted", family: "import", source: "import { " + statusName + ", " + providerAssessorName + " } from " + apostrophe + providerModule + apostrophe + ";\n" + permittedExport, expected: true },
  { name: "wrong-source", family: "import", source: permittedImport.replace(providerModule, "./wrong.mjs") + "\n" + permittedExport, expected: false },
  { name: "missing-status", family: "import", source: "import { " + providerAssessorName + " } from \"" + providerModule + "\";\nconst " + statusName + " = 1;\n" + permittedExport, expected: false },
  { name: "missing-assessor", family: "import", source: "import { " + statusName + " } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "status-alias", family: "import", source: "import { " + statusName + " as status, " + providerAssessorName + " } from \"" + providerModule + "\";\nexport { status };", expected: false },
  { name: "status-redundant-alias", family: "import", source: "import { " + statusName + " as " + statusName + ", " + providerAssessorName + " } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "assessor-alias", family: "import", source: "import { " + statusName + ", " + providerAssessorName + " as provider } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "assessor-redundant-alias", family: "import", source: "import { " + statusName + ", " + providerAssessorName + " as " + providerAssessorName + " } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "third-binding", family: "import", source: "import { " + statusName + ", " + providerAssessorName + ", extra } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "default-import", family: "import", source: "import value, { " + statusName + ", " + providerAssessorName + " } from \"" + providerModule + "\";\n" + permittedExport, expected: false },
  { name: "namespace-import", family: "import", source: "import * as values from \"" + providerModule + "\";\nconst " + statusName + " = 1;\n" + permittedExport, expected: false },
  { name: "side-effect-import", family: "import", source: "import \"" + providerModule + "\";\nconst " + statusName + " = 1;\n" + permittedExport, expected: false },
  { name: "second-import", family: "import", source: canonicalSource + "\nimport value from \"./other.mjs\";", expected: false },
  { name: "same-line-import-after-block", family: "import", source: "const text = " + templateQuote + canonicalSource + templateQuote + ";\nif (true) {} " + permittedImport.replace(providerModule, "./wrong.mjs") + "\n" + permittedExport, expected: false },
  { name: "comment-decoy", family: "import", source: "/* " + canonicalSource + " */\nconst value = 1;", expected: false },
  { name: "string-decoy", family: "import", source: "const text = " + JSON.stringify(canonicalSource) + ";", expected: false },
  { name: "template-decoy", family: "import", source: "const text = " + templateQuote + canonicalSource + templateQuote + ";", expected: false },
  { name: "export-alias", family: "export", source: permittedImport + "\nexport { " + statusName + " as status };", expected: false },
  { name: "export-redundant-alias", family: "export", source: permittedImport + "\nexport { " + statusName + " as " + statusName + " };", expected: false },
  { name: "export-extra-binding", family: "export", source: permittedImport + "\nconst extra = 1;\nexport { " + statusName + ", extra };", expected: false },
  { name: "second-export-block", family: "export", source: canonicalSource + "\nexport { " + providerAssessorName + " };", expected: false },
  { name: "named-source-reexport", family: "export", source: canonicalSource + "\nexport { value } from \"./other.mjs\";", expected: false },
  { name: "star-source-reexport", family: "export", source: canonicalSource + "\nexport * from \"./other.mjs\";", expected: false },
  { name: "namespace-source-reexport", family: "export", source: canonicalSource + "\nexport * as values from \"./other.mjs\";", expected: false },
  { name: "default-export-expression", family: "export", source: canonicalSource + "\nexport default 1;", expected: false },
  { name: "default-export-function", family: "export", source: canonicalSource + "\nexport default function value() {}", expected: false },
  { name: "default-export-class", family: "export", source: canonicalSource + "\nexport default class Value {}", expected: false },
  { name: "same-line-reexport-after-block", family: "export", source: canonicalSource + "\nif (true) {} export { value } from \"./other.mjs\";", expected: false },
  { name: "exported-variable", family: "export", source: canonicalSource + "\nexport const value = 1;", expected: true },
  { name: "exported-function", family: "export", source: canonicalSource + "\nexport function value() {}", expected: true },
  { name: "exported-class", family: "export", source: canonicalSource + "\nexport class Value {}", expected: true },
  { name: "import-meta", family: "export", source: canonicalSource + "\nconst value = import.meta.url;", expected: true },
  { name: "dynamic-import", family: "export", source: canonicalSource + "\nconst value = import(\"./other.mjs\");", expected: false }
];

const selfFixtureNames = [
  "allowed-four-imports",
  "allowed-dependency-call",
  "provider-import",
  "workload-import",
  "unapproved-source",
  "fifth-duplicate-import",
  "fifth-extra-import",
  "fifth-dynamic-import",
  "provider-direct-call",
  "workload-direct-call",
  "provider-property-call",
  "workload-property-call",
  "provider-string-computed-call",
  "workload-string-computed-call",
  "provider-name-variable-call",
  "workload-name-variable-call"
];

const selfFixtures = [
  { name: "allowed-four-imports", source: permittedSelfImports, expected: true },
  { name: "allowed-dependency-call", source: permittedSelfImports + "\nreadFileSync(new URL(import.meta.url), \"utf8\");", expected: true },
  { name: "provider-import", source: permittedSelfImports.replace("import ts from \"typescript\";", "import * as provider from \"" + providerModule + "\";"), expected: false },
  { name: "workload-import", source: permittedSelfImports.replace("import ts from \"typescript\";", "import * as workload from \"" + workloadModule + "\";"), expected: false },
  { name: "unapproved-source", source: permittedSelfImports.replace("import ts from \"typescript\";", "import path from \"node:path\";"), expected: false },
  { name: "fifth-duplicate-import", source: permittedSelfImports + "\nimport \"node:fs\";", expected: false },
  { name: "fifth-extra-import", source: permittedSelfImports + "\nimport \"node:path\";", expected: false },
  { name: "fifth-dynamic-import", source: permittedSelfImports + "\nimport(\"node:path\");", expected: false },
  { name: "provider-direct-call", source: permittedSelfImports + "\n" + providerAssessorName + "();", expected: false },
  { name: "workload-direct-call", source: permittedSelfImports + "\n" + workloadAssessorName + "();", expected: false },
  { name: "provider-property-call", source: permittedSelfImports + "\nsubject." + providerAssessorName + "();", expected: false },
  { name: "workload-property-call", source: permittedSelfImports + "\nsubject." + workloadAssessorName + "();", expected: false },
  { name: "provider-string-computed-call", source: permittedSelfImports + "\nsubject[" + JSON.stringify(providerAssessorName) + "]();", expected: false },
  { name: "workload-string-computed-call", source: permittedSelfImports + "\nsubject[" + JSON.stringify(workloadAssessorName) + "]();", expected: false },
  { name: "provider-name-variable-call", source: permittedSelfImports + "\nconst providerAssessorName = [\"assessAzureRelease\", \"ProviderIdentity\"].join(\"\");\nsubject[providerAssessorName]();", expected: false },
  { name: "workload-name-variable-call", source: permittedSelfImports + "\nconst workloadAssessorName = [\"assessAzureRelease\", \"WorkloadIdentity\"].join(\"\");\nsubject[workloadAssessorName]();", expected: false }
];

describe("Azure release workload identity static module surface", () => {
  test("proves the production module surface from parsed declarations", () => {
    expect(productionSource.length).toBeGreaterThan(0);
    expect(testSource.length).toBeGreaterThan(0);
    expect(moduleSurfaceIsExact(productionSource)).toBe(true);
  });

  test("binds the independent fixture contract without execution", () => {
    expect(fixtures.map(({ name }) => name)).toStrictEqual(fixtureNames);
    expect(fixtures).toHaveLength(42);
    expect(new Set(fixtures.map(({ name }) => name)).size).toBe(42);
    for (const fixture of fixtures) {
      syntaxCheck(fixture.source);
      expect(moduleSurfaceIsExact(fixture.source), fixture.name).toBe(fixture.expected);
    }
    for (const family of ["import", "export"]) {
      const rows = fixtures.filter((fixture) => fixture.family === family);
      expect(rows.some(({ expected }) => expected), family).toBe(true);
      expect(rows.some(({ expected }) => !expected), family).toBe(true);
    }
  });

  test("binds parsed self-source import and call isolation", () => {
    expect(selfSourceIsExact(testSource)).toBe(true);
    expect(selfFixtures.map(({ name }) => name)).toStrictEqual(selfFixtureNames);
    expect(selfFixtures).toHaveLength(16);
    expect(new Set(selfFixtures.map(({ name }) => name)).size).toBe(16);
    for (const fixture of selfFixtures) {
      syntaxCheck(fixture.source);
      expect(selfSourceIsExact(fixture.source), fixture.name).toBe(fixture.expected);
    }
    expect(selfFixtures.some(({ expected }) => expected)).toBe(true);
    expect(selfFixtures.some(({ expected }) => !expected)).toBe(true);
  });

  test("contains neither assessor and locks both exact caller sets", () => {
    expect(testSource.includes(providerAssessorName)).toBe(false);
    expect(testSource.includes(workloadAssessorName)).toBe(false);
    const cwd = new URL("../../", import.meta.url);
    const providerOutput = execFileSync("git", ["grep", "-l", providerAssessorName], { cwd, encoding: "utf8" });
    const workloadOutput = execFileSync("git", ["grep", "-l", workloadAssessorName], { cwd, encoding: "utf8" });
    expect(providerOutput.trim().split("\n").sort()).toStrictEqual(["scripts/release/azure-release-provider-identity-core.test.mjs", "scripts/release/azure-release-provider-identity-hardening.test.mjs", "scripts/release/azure-release-provider-identity.mjs", "scripts/release/azure-release-workload-identity.mjs"]);
    expect(workloadOutput.trim().split("\n").sort()).toStrictEqual(["scripts/release/azure-release-workload-identity-core.test.mjs", "scripts/release/azure-release-workload-identity-hardening.test.mjs", "scripts/release/azure-release-workload-identity.mjs"]);
  });
});
