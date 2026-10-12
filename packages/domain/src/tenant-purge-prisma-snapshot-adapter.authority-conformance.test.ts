import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const BASENAME = "tenant-purge-prisma-snapshot-adapter";
const FACTORY = "createTenantPurgePrismaAuthorizeAndCapture";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SOURCE_PATH = `packages/domain/src/${BASENAME}.ts`;
const SOURCE = readFileSync(path.join(ROOT, SOURCE_PATH), "utf8");
const PARAMETERS = ["privateAuthority", "targetMode", "runId", "redactionKeyBytes",
  "pageSize", "maxPagesPerModel", "maxEvidenceItems", "cacheMaxTtlSeconds"];
const IMPORTS = new Map([
  ["@prisma/client", ["Prisma"]], ["@corgtex/shared", ["prisma"]],
  ["./tenant-purge-atomic-capture-contract", ["TenantPurgeAuthorizeAndCapture"]],
  ["./tenant-purge-owned-collection-kernel", ["createTenantPurgeOwnedEntry"]],
  ["./tenant-purge-prisma-snapshot-value-kernel", ["captureTenantPurgePrismaClockMilliseconds",
    "captureTenantPurgePrismaDateMilliseconds", "captureTenantPurgePrismaOrderedUuidVector", "captureTenantPurgePrismaRowValues"]],
  ["./tenant-purge-owned-vector-kernel", ["captureTenantPurgeOwnedVector", "createTenantPurgeOwnedVector",
    "pushTenantPurgeOwnedVector", "TenantPurgeOwnedVector"]],
  ["./tenant-purge-value-scalar-kernel", ["compileTenantPurgeScalarSpec", "copyTenantPurgeScalar", "invalidTenantPurgeValue"]],
]);
const READS = new Set(["tenantPurgeRun.findUnique", "workspace.findUnique", "customerDeployment.findUnique",
  "customerDeployment.findMany", "customerAccount.findUnique", "customerAccount.findMany",
  "procurementTrial.findUnique", "procurementTrial.findMany", "providerCutover.findFirst", "clientMigrationRun.findFirst"]);
const FORBIDDEN_MEMBERS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany",
  "updateManyAndReturn", "upsert", "delete", "deleteMany", "aggregate", "groupBy", "count", "include",
  "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe", "$connect", "$disconnect",
  "$extends", "$use", "$on", "fetch", "retry", "lock", "advisoryLock", "log", "warn", "error"]);
const FORBIDDEN_IDENTIFIERS = new Set(["fetch", "globalThis", "global", "window", "process", "console",
  "PrismaClient", "require", "eval", "Function", "WebSocket", "XMLHttpRequest", "setTimeout", "setInterval"]);
function parse(source: string, filename = "specimen.ts") {
  return ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const value = unwrap(node); return ts.isStringLiteralLike(value) ? value.text : undefined;
}
function member(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return literalText(node.argumentExpression);
  return undefined;
}
function access(node: ts.Node): string | undefined {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node.text;
  const name = member(node);
  if (name && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
    const base = access(node.expression); return base ? `${base}.${name}` : undefined;
  }
  return undefined;
}
function literalPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return literalText(name.expression);
  return undefined;
}
// A regression guard for this deliberately small source, not a general JS sandbox or
// data-flow proof. Runtime query ledgers separately enforce arguments and read order.
function authorityIssues(source: string): string[] {
  const file = parse(source); const issues = new Set<string>(); const imports = new Map<string, string[]>();
  const exports: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleName = ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const bindings = node.importClause?.namedBindings;
      if (!IMPORTS.has(moduleName) || node.importClause?.name || !bindings || !ts.isNamedImports(bindings)
        || bindings.elements.some((binding) => !!binding.propertyName) || imports.has(moduleName)) issues.add("imports");
      else imports.set(moduleName, bindings.elements.map((binding) => binding.name.text));
    }
    if (ts.isImportEqualsDeclaration(node)
      || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) issues.add("imports");
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) issues.add("exports");
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.push(node);
      if (!ts.isFunctionDeclaration(node) || node.name?.text !== FACTORY
        || ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) issues.add("exports");
      else if (node.parameters.length !== 8 || node.parameters.some((parameter, index) =>
        !ts.isIdentifier(parameter.name) || parameter.name.text !== PARAMETERS[index]
        || !!parameter.questionToken || !!parameter.dotDotDotToken || !!parameter.initializer
        || parameter.type?.kind !== ts.SyntaxKind.UnknownKeyword)) issues.add("parameters");
    }
    const property = member(node);
    if (property && FORBIDDEN_MEMBERS.has(property)) issues.add("forbidden operation");
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isMethodDeclaration(node))
      && FORBIDDEN_MEMBERS.has(literalPropertyName(node.name) ?? ""))
      issues.add("forbidden operation");
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) issues.add("ambient authority");
    if (ts.isIdentifier(node) && ["prisma", "tx", "Prisma"].includes(node.text)) {
      const declaration = ts.isImportSpecifier(node.parent) || (ts.isParameter(node.parent) && node.parent.name === node);
      if (!declaration) {
        let outer: ts.Node = node;
        while ((ts.isPropertyAccessExpression(outer.parent) || ts.isElementAccessExpression(outer.parent))
          && outer.parent.expression === outer) outer = outer.parent;
        const name = access(outer);
        const call = ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
        if (node.text === "Prisma" ? name !== "Prisma.TransactionIsolationLevel.RepeatableRead"
          : !call || (node.text === "prisma" ? name !== "prisma.$transaction" : !READS.has(name?.slice(3) ?? "")))
          issues.add("database capability escape");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (exports.length !== 1) issues.add("exports");
  if (imports.size !== IMPORTS.size || [...IMPORTS].some(([moduleName, names]) =>
    JSON.stringify(imports.get(moduleName)?.slice().sort()) !== JSON.stringify(names.slice().sort()))) issues.add("imports");
  return [...issues].sort();
}
function referencesAdapter(source: string, filename = "specimen.ts"): boolean {
  let found = false;
  const matches = (value: string) => /(?:^|\/)tenant-purge-prisma-snapshot-adapter(?:\.[cm]?[jt]sx?)?$/.test(value);
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && matches(literalText(node.moduleSpecifier) ?? "")) found = true;
    if (ts.isExternalModuleReference(node) && matches(literalText(node.expression) ?? "")) found = true;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal) && matches(node.argument.literal.text)) found = true;
    if (ts.isCallExpression(node) && (unwrap(node.expression).kind === ts.SyntaxKind.ImportKeyword
      || access(node.expression) === "require" || access(node.expression) === "module.require")
      && matches(literalText(node.arguments[0]) ?? "")) found = true;
    // Also catches a named re-export/import through an intermediate barrel or alias.
    if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node))
      && [node.name.text, node.propertyName?.text].includes(FACTORY)) found = true;
    ts.forEachChild(node, visit);
  }
  visit(parse(source, filename)); return found;
}
function exportsAdapter(value: unknown, packageFile: string, pattern = false): boolean {
  if (typeof value === "string") {
    if (value.includes(BASENAME)) return true;
    if (!pattern || !value.startsWith("./") || !value.includes("*")) return false;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(packageFile), value));
    const expression = new RegExp(`^${target.split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    // Include corresponding JS paths as well as source and extensionless targets.
    return ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
      .some((extension) => expression.test(SOURCE_PATH.replace(/\.ts$/, extension)));
  }
  if (Array.isArray(value)) return value.some((target) => exportsAdapter(target, packageFile, pattern));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, target]) =>
    exportsAdapter(target, packageFile, key.startsWith(".") ? key.includes("*") : pattern));
  return false;
}

describe("snapshot adapter static authority conformance", () => {
  it("keeps the actual adapter's only export, exact private parameters, imports and read-only capabilities", () => {
    expect(authorityIssues(SOURCE)).toEqual([]);
  });
  const forbidden = [
    ["bare fetch", "fetch('/external')", "ambient authority"],
    ["global fetch", "globalThis.fetch('/external')", "ambient authority"],
    ["bracket global fetch", "globalThis['fetch']('/external')", "ambient authority"],
    ["optional global fetch", "globalThis?.fetch?.('/external')", "ambient authority"],
    ["network SDK", "import { request } from 'node:https';", "imports"],
    ["SDK dynamic import", "import(/* hidden */ 'openai')", "imports"],
    ["require", "require(/* hidden */ 'node:http')", "ambient authority"],
    ["extra Prisma client", "new PrismaClient()", "ambient authority"],
    ["console", "console.log('detail')", "ambient authority"],
    ["retry", "helper.retry(operation)", "forbidden operation"],
    ["lock", "helper['lock']()", "forbidden operation"],
    ["include", "const query = { include: { workspace: true } }", "forbidden operation"],
    ["literal computed include", "const query = { ['include']: { workspace: true } }", "forbidden operation"],
    ["template computed include", "const query = { [`include`]: { workspace: true } }", "forbidden operation"],
    ["shorthand include", "const include = { workspace: true }; const query = { include }", "forbidden operation"],
    ["getter include", "const query = { get include() { return { workspace: true }; } }", "forbidden operation"],
    ["computed getter include", "const query = { get ['include']() { return { workspace: true }; } }", "forbidden operation"],
    ["parenthesized computed include", "const query = { [('include')]: { workspace: true } }", "forbidden operation"],
    ["asserted computed include", "const query = { ['include' as const]: { workspace: true } }", "forbidden operation"],
    ["wrapped bracket retry", "helper[('retry')](operation)", "forbidden operation"],
    ["shared escape", "const anotherClient = prisma", "database capability escape"],
    ["transaction escape", "const { customerAccount } = tx", "database capability escape"],
    ["unknown read", "tx.workspace.findFirst({})", "database capability escape"],
    ...["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "aggregate", "count", "groupBy"]
      .flatMap((method) => [[`dot ${method}`, `tx.workspace.${method}({})`, "forbidden operation"],
        [`bracket ${method}`, `tx.workspace['${method}']({})`, "forbidden operation"]]),
    ...["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"].flatMap((method) =>
      [[`dot ${method}`, `tx.${method}('SELECT 1')`, "forbidden operation"],
        [`bracket ${method}`, `prisma['${method}']('SELECT 1')`, "forbidden operation"]]),
    ["extra export", "export const unsafe = 1", "exports"],
    ["default export", "export default 1", "exports"],
    ["export list", "export { DENIED }", "exports"],
    ["barrel export", "export * from './tenant-purge-owned-vector-kernel'", "exports"],
    ["type export", "export type Extra = unknown", "exports"],
  ];
  it.each(forbidden)("rejects a failing %s specimen", (_label, specimen, issue) => {
    expect(authorityIssues(`${SOURCE}\n${specimen};`)).toContain(issue);
  });
  it.each([
    ["ninth innocently named parameter", "cacheMaxTtlSeconds: unknown, extra: unknown,"],
    ["optional parameter", "cacheMaxTtlSeconds?: unknown,"],
    ["default parameter", "cacheMaxTtlSeconds: unknown = 60,"],
    ["rest parameter", "...cacheMaxTtlSeconds: unknown[],"],
  ])("rejects %s instead of relying on suspicious parameter names", (_label, replacement) => {
    expect(authorityIssues(SOURCE.replace("cacheMaxTtlSeconds: unknown,", replacement))).toContain("parameters");
  });
  it("allows legitimate internal Date/byte values and ignores comments and prose", () => {
    expect(authorityIssues(`${SOURCE}\nconst date = new Date(0); const bytes = new Uint8Array(32);
      // globalThis.fetch and tx.workspace.delete must not be false positives.
      const prose = 'export default fetch';`)).toEqual([]);
  });
});

describe("snapshot adapter remains inert and package-internal", () => {
  it.each([
    `import { ${FACTORY} } from './${BASENAME}'`, `import './${BASENAME}.ts'`,
    `export * from './${BASENAME}'`, `export { ${FACTORY} as capture } from './internal-barrel'`,
    `import { ${FACTORY} as capture } from '@corgtex/domain'`,
    `type T = import('./${BASENAME}').T`, `import capture = require('./${BASENAME}')`,
    `import(/* deliberate comment */ './${BASENAME}')`, `require(/* deliberate comment */ './${BASENAME}')`,
    `module.require(/* comment */ './${BASENAME}')`, `import(\`./${BASENAME}\`)`,
    `import(('./${BASENAME}'))`, `require(('./${BASENAME}'))`,
    `require(('./${BASENAME}' as string))`, `(require)('./${BASENAME}')`,
    `import(('./${BASENAME}' satisfies string))`, `require((<string>'./${BASENAME}')!)`,
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((extension) => `export * from '../src/${BASENAME}.${extension}'`),
  ])("detects import/export specimen %s", (source) => { expect(referencesAdapter(source)).toBe(true); });
  it("ignores prose, comments, test names and unrelated imports", () => {
    expect(referencesAdapter(`// import './${BASENAME}'\nconst prose = "require('./${BASENAME}')";
      it('export * from ./${BASENAME}', () => {}); import './other';`)).toBe(false);
  });
  it("does not claim to evaluate variable or concatenated module paths", () => {
    expect(referencesAdapter(`const target = './${BASENAME}'; import(target);`)).toBe(false);
    expect(referencesAdapter("import('./tenant-purge-' + 'prisma-snapshot-adapter')")).toBe(false);
  });
  it.each([
    { ".": `./src/${BASENAME}.ts` }, { "./*": "./src/*.ts" }, { "./internal/*": "./src/*" },
    { "./*": { import: "./src/*.js", require: "./src/*.cjs" } },
    { "./*": [null, { default: "./src/*.ts" }] },
    { "./tenant-purge-*": "./src/tenant-purge-*.ts" },
  ])("rejects an exposing static package-export specimen %j", (exports) => {
    expect(exportsAdapter(exports, "packages/domain/package.json")).toBe(true);
  });
  it("allows package export maps whose static targets do not expose the adapter", () => {
    expect(exportsAdapter({ ".": "./src/index.ts", "./public/*": "./src/public/*.ts" },
      "packages/domain/package.json")).toBe(false);
    expect(exportsAdapter({ "./*": "./src/*.ts" }, "packages/agents/package.json")).toBe(false);
    expect(exportsAdapter({ "./hidden": null }, "packages/domain/package.json")).toBe(false);
  });
  it("scans relevant source extensions, barrels and package export maps with an exact test allowlist", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    const allowed = new Set([`packages/domain/src/${BASENAME}.test.ts`,
      `packages/domain/src/${BASENAME}.authority-conformance.test.ts`]);
    const consumers = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !allowed.has(file))
      .filter((file) => referencesAdapter(readFileSync(path.join(ROOT, file), "utf8"), file));
    expect(consumers).toEqual([]);
    const exposed = files.filter((file) => /(?:^|\/)package\.json$/.test(file)).filter((file) => {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as { exports?: unknown };
      return exportsAdapter(manifest.exports, file);
    });
    expect(exposed).toEqual([]);
    expect(files).toContain("packages/domain/src/index.ts");
  });
  // Literal AST references and the factory's named imports/exports are covered.
  // Computed module paths, custom resolver aliases that hide both names, generated or
  // ignored build outputs and arbitrary runtime data flow require separate review.
});
