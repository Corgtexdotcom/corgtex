import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { MCP_TOOL_CAPABILITIES } from "../../../packages/domain/src/mcp-tool-capabilities";

vi.mock("@corgtex/domain", async () => import("../../../packages/domain/src/agent-operation-capabilities"));

import { AGENT_REST_ROUTE_CAPABILITIES, getAgentRouteCapability, requireAgentRouteCapability } from "./agent-route-capabilities";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appRoot = join(webRoot, "app");
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const authEntrypoints = new Set(["resolveRequestActor", "resolveControlPlaneRequestActor", "resolveAgentActorFromBearer", "withWorkspaceRoute"]);
// These exact methods use independent authentication instead of the REST resolver.
const independentlyAuthorizedMethods = new Set([
  "GET /api/control-plane/mcp",
  "POST /api/control-plane/mcp",
  "POST /api/webhooks/[workspaceId]/ingest",
]);

type ModuleInfo = { dependencies: string[]; methods: Set<string>; callsAuth: boolean; exportAll: string[] };

function inspectModule(source: string): ModuleInfo {
  const ast = ts.createSourceFile("synthetic.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const info: ModuleInfo = { dependencies: [], methods: new Set(), callsAuth: false, exportAll: [] };
  const authBindings = new Set(authEntrypoints);
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      info.dependencies.push(statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (authEntrypoints.has((element.propertyName ?? element.name).text)) authBindings.add(element.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        info.dependencies.push(statement.moduleSpecifier.text);
        if (!statement.exportClause) info.exportAll.push(statement.moduleSpecifier.text);
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (httpMethods.has(element.name.text)) info.methods.add(element.name.text);
        }
      }
    }
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && httpMethods.has(statement.name.text)) {
      info.methods.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text)) info.methods.add(declaration.name.text);
      }
    }
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (authBindings.has(name)) info.callsAuth = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return info;
}

function localModule(from: string, specifier: string) {
  const base = specifier.startsWith("@/") ? join(webRoot, specifier.slice(2))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base || !base.startsWith(`${webRoot}/`)) return null;
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
    .find(candidate => /\.tsx?$/.test(candidate) && existsSync(candidate)) ?? null;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(path) : entry.name === "route.ts" ? [path] : [];
  });
}

function authenticatedRouteInventory() {
  const routes = routeFiles(appRoot);
  const modules = new Map<string, ModuleInfo>();
  function load(path: string) {
    if (modules.has(path)) return;
    const info = inspectModule(readFileSync(path, "utf8"));
    const resolvedDependencies = info.dependencies.map(specifier => localModule(path, specifier)).filter((value): value is string => !!value);
    info.exportAll = info.exportAll.map(specifier => localModule(path, specifier)).filter((value): value is string => !!value);
    info.dependencies = resolvedDependencies;
    modules.set(path, info);
    for (const dependency of info.dependencies) load(dependency);
  }
  routes.forEach(load);
  const authenticated = new Set([...modules].filter(([, info]) => info.callsAuth).map(([path]) => path));
  // A fixed point handles cycles and catches imported helpers and route aliases.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, info] of modules) {
      if (!authenticated.has(path) && info.dependencies.some(dependency => authenticated.has(dependency))) {
        authenticated.add(path);
        changed = true;
      }
      for (const dependency of info.exportAll) {
        for (const method of modules.get(dependency)?.methods ?? []) {
          if (!info.methods.has(method)) { info.methods.add(method); changed = true; }
        }
      }
    }
  }
  return routes.filter(path => authenticated.has(path)).flatMap(path => {
    const template = `/${relative(appRoot, path).replace(/\/route\.ts$/, "")}`;
    return [...modules.get(path)!.methods].map(method => `${method} ${template}`)
      .filter(operation => !independentlyAuthorizedMethods.has(operation));
  }).sort();
}

describe("agent REST route authorization inventory fence", () => {
  it("classifies every actor-resolving route method, including imported helpers and aliases", () => {
    const declared = Object.entries(AGENT_REST_ROUTE_CAPABILITIES).flatMap(([template, methods]) =>
      Object.keys(methods).map(method => `${method} ${template}`)).sort();
    expect(authenticatedRouteInventory()).toEqual(declared);
  });

  it("declares CRM archive GET with the canonical relationships read grant", () => {
    const pathname = "/api/workspaces/workspace-1/leads/archive";
    const request = {method: "GET", nextUrl: {pathname}};
    const credential = (scopes: string[]): AppActor => ({kind: "agent", authProvider: "credential", label: "synthetic-crm-presentation", workspaceIds: ["workspace-1"], scopes});
    expect(getAgentRouteCapability("GET", pathname)).toEqual({operation: "list_relationship_accounts", feature: "RELATIONSHIPS"});
    expect(MCP_TOOL_CAPABILITIES.list_relationship_accounts.scopes).toEqual(["relationships:read"]);
    expect(() => requireAgentRouteCapability(credential(["relationships:read"]), request)).not.toThrow();
    for (const scopes of [[], ["relationships:write"], ["actions:read"]]) {
      expect(() => requireAgentRouteCapability(credential(scopes), request, {deferToolLinkScope: true})).toThrow();
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      expect(() => requireAgentRouteCapability(credential(["relationships:read", "relationships:write"]), {...request, method})).toThrow();
    }
  });

  it("keeps category administration and explicit Brain consent unavailable to credential agents", () => {
    const actor: AppActor = { kind: "agent", authProvider: "credential", label: "synthetic-agent", workspaceIds: ["workspace-1"], scopes: ["conversations:write", "brain:write"] };
    for (const [method, pathname] of [
      ["PATCH", "/api/workspaces/workspace-1/information-categories"],
      ["POST", "/api/workspaces/workspace-1/information-categories"],
      ["POST", "/api/workspaces/workspace-1/conversations/conversation-1/brain"],
    ]) {
      expect(getAgentRouteCapability(method, pathname)).toEqual({ operation: null });
      expect(() => requireAgentRouteCapability(actor, { method, nextUrl: { pathname } })).toThrow();
    }
  });

  it("discovers aliased actor imports, wrapper exports, and reexported HTTP methods using syntax", () => {
    const inspected = inspectModule(`
      import { resolveRequestActor as authenticate } from "@/lib/auth";
      export const GET = async (request: unknown) => authenticate(request);
      export { POST as PATCH, DELETE } from "./other-route";
      export * from "./third-route";
    `);
    expect(inspected.callsAuth).toBe(true);
    expect([...inspected.methods].sort()).toEqual(["DELETE", "GET", "PATCH"]);
    expect(inspected.dependencies).toEqual(["@/lib/auth", "./other-route", "./third-route"]);
    expect(inspected.exportAll).toEqual(["./third-route"]);
    expect(inspectModule(`export const POST = withWorkspaceRoute(async () => null);`).callsAuth).toBe(true);
  });

  it("does not confuse commented authentication text with an authenticated route", () => {
    expect(inspectModule(`// resolveRequestActor(request)\nexport async function GET() { return null; }`).callsAuth).toBe(false);
  });

  it("fences the independent inbound webhook scope before its payload handler", () => {
    const source = readFileSync(join(appRoot, "api/webhooks/[workspaceId]/ingest/route.ts"), "utf8");
    const ast = ts.createSourceFile("webhook.ts", source, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    let declaredScope: string | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "INBOUND_WEBHOOK_SCOPE"
        && node.initializer && ts.isStringLiteral(node.initializer)) declaredScope = node.initializer.text;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    const namedCalls = (name: string) => calls.filter(call => ts.isIdentifier(call.expression) && call.expression.text === name);
    const scopeChecks = namedCalls("requireAgentScope");
    const membershipChecks = namedCalls("requireWorkspaceMembership");
    const handlers = namedCalls("processInboundWebhook");
    expect(declaredScope).toBe("webhooks:write");
    expect(namedCalls("resolveAgentActorFromBearer")).toHaveLength(1);
    expect(scopeChecks).toHaveLength(1);
    expect(scopeChecks[0].arguments.map(argument => argument.getText(ast))).toEqual(["actor", "INBOUND_WEBHOOK_SCOPE"]);
    expect(membershipChecks).toHaveLength(1);
    expect(handlers).toHaveLength(1);
    expect(membershipChecks[0].pos).toBeLessThan(scopeChecks[0].pos);
    expect(scopeChecks[0].pos).toBeLessThan(handlers[0].pos);
    expect([...inspectModule(source).methods]).toEqual(["POST"]);
  });
});
