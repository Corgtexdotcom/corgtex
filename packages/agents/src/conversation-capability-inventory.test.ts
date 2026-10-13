import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/agent-operation-capabilities"),
  requireWorkspaceOperation: vi.fn(),
}));
import { CONVERSATION_TOOL_CAPABILITIES } from "./conversation-capabilities";

function namedInitializer(ast: ts.SourceFile, name: string): ts.Expression {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!initializer) throw new Error(`Missing handler registry ${name}.`);
  return initializer;
}

function unwrapAnnotations(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrapAnnotations(node.expression) : node;
}

function isObjectCall(node: ts.Expression, method: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
    && node.expression.name.text === method;
}

function isOuterGuard(ast: ts.SourceFile, name: string) {
  const initializer = unwrapAnnotations(namedInitializer(ast, name));
  return ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
    && initializer.expression.text === "guardConversationToolHandlers" && initializer.arguments.length === 1;
}

function namedObject(ast: ts.SourceFile, name: string, visited = new Set<string>()): ts.ObjectLiteralExpression {
  if (visited.has(name)) throw new Error(`Cyclic handler initializer ${name}.`);
  const nextVisited = new Set([...visited, name]);
  const initializer = namedInitializer(ast, name);
  function unwrap(node: ts.Expression): ts.ObjectLiteralExpression {
    const value = unwrapAnnotations(node);
    if (ts.isObjectLiteralExpression(value)) return value;
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)
      && value.expression.text === "guardConversationToolHandlers" && value.arguments.length === 1) return unwrap(value.arguments[0]);
    // The source-lineage receipt wrapper preserves each raw registry key. Follow
    // only this exact Object.entries(...).map(([name, handler]) => [name, fn]) shape.
    if (isObjectCall(value, "fromEntries") && value.arguments.length === 1) {
      const mapped = value.arguments[0];
      if (ts.isCallExpression(mapped) && ts.isPropertyAccessExpression(mapped.expression)
        && mapped.expression.name.text === "map" && mapped.arguments.length === 1
        && isObjectCall(mapped.expression.expression, "entries") && mapped.expression.expression.arguments.length === 1) {
        const rawName = mapped.expression.expression.arguments[0];
        const callback = mapped.arguments[0];
        if (ts.isIdentifier(rawName) && ts.isArrowFunction(callback) && callback.parameters.length === 1
          && ts.isArrayBindingPattern(callback.parameters[0].name) && callback.parameters[0].name.elements.length === 2
          && ts.isArrayLiteralExpression(callback.body) && callback.body.elements.length === 2) {
          const binding = callback.parameters[0].name.elements[0];
          if (ts.isBindingElement(binding) && !binding.dotDotDotToken && ts.isIdentifier(binding.name)
            && ts.isIdentifier(callback.body.elements[0]) && callback.body.elements[0].text === binding.name.text
            && ts.isArrowFunction(callback.body.elements[1])) return namedObject(ast, rawName.text, nextVisited);
        }
      }
    }
    throw new Error(`Unclassified initializer for ${name}.`);
  }
  return unwrap(initializer);
}

function handlerNames(path: string, registry: string, visited = new Set<string>()): string[] {
  const identity = `${path}:${registry}`;
  if (visited.has(identity)) throw new Error(`Cyclic handler registry ${identity}.`);
  const nextVisited = new Set([...visited, identity]);
  const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const imported = new Map<string, { path: string; name: string }>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    for (const element of bindings.elements) {
      imported.set(element.name.text, {
        path: resolve(dirname(path), `${specifier}.ts`),
        name: (element.propertyName ?? element.name).text,
      });
    }
  }
  return namedObject(ast, registry).properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) {
      if (!ts.isIdentifier(property.expression)) throw new Error("Unclassified dynamic native handler spread.");
      const dependency = imported.get(property.expression.text);
      return dependency ? handlerNames(dependency.path, dependency.name, nextVisited)
        : handlerNames(path, property.expression.text, nextVisited);
    }
    if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return [property.name.text];
    throw new Error("Unclassified computed native handler name.");
  });
}

describe("native conversation capability inventory fence", () => {
  it("classifies all native handlers and imported context-map handler spreads", () => {
    const source = fileURLToPath(new URL("./conversation.ts", import.meta.url));
    const names = handlerNames(source, "TOOL_HANDLERS");
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(CONVERSATION_TOOL_CAPABILITIES).sort());
  });

  it("keeps the final production dispatch registry inside the authorization guard", () => {
    const source = fileURLToPath(new URL("./conversation.ts", import.meta.url));
    const ast = ts.createSourceFile(source, readFileSync(source, "utf8"), ts.ScriptTarget.Latest, true);
    expect(isOuterGuard(ast, "TOOL_HANDLERS")).toBe(true);
  });

  it("recognizes a registry wrapped in the dispatch guard", () => {
    const ast = ts.createSourceFile("synthetic.ts", `
      const TOOL_HANDLERS = guardConversationToolHandlers({ query_actions: readAction, newly_added_tool: writeAction });
    `, ts.ScriptTarget.Latest, true);
    const object = namedObject(ast, "TOOL_HANDLERS");
    expect(object.properties.map(property => property.name?.getText(ast))).toEqual(["query_actions", "newly_added_tool"]);
    expect(CONVERSATION_TOOL_CAPABILITIES).not.toHaveProperty("newly_added_tool");
  });

  it("fails closed if a registry becomes a dynamic uninspectable value", () => {
    const ast = ts.createSourceFile("synthetic.ts", "const TOOL_HANDLERS = loadDynamicHandlers();", ts.ScriptTarget.Latest, true);
    expect(() => namedObject(ast, "TOOL_HANDLERS")).toThrow("Unclassified initializer");
  });

  it("follows the exact source-receipt wrapper inside the outer authorization guard", () => {
    const ast = ts.createSourceFile("synthetic.ts", `
      const RAW_TOOL_HANDLERS = { query_actions: readAction };
      const TOOL_HANDLERS = guardConversationToolHandlers<ConversationContext>(
        Object.fromEntries(Object.entries(RAW_TOOL_HANDLERS).map(([toolName, handler]) => [toolName,
          async (actor, ctx, args) => { await collector.assertReadable(); return handler(actor, ctx, args); },
        ])) as typeof RAW_TOOL_HANDLERS,
      );
    `, ts.ScriptTarget.Latest, true);
    expect(isOuterGuard(ast, "TOOL_HANDLERS")).toBe(true);
    expect(namedObject(ast, "TOOL_HANDLERS").properties.map(property => property.name?.getText(ast))).toEqual(["query_actions"]);
  });

  it("does not accept a transform that synthesizes different handler keys", () => {
    const ast = ts.createSourceFile("synthetic.ts", `
      const RAW_TOOL_HANDLERS = { query_actions: readAction };
      const TOOL_HANDLERS = guardConversationToolHandlers(Object.fromEntries(
        Object.entries(RAW_TOOL_HANDLERS).map(([toolName, handler]) => [dynamicName(toolName), async () => handler()]),
      ));
    `, ts.ScriptTarget.Latest, true);
    expect(() => namedObject(ast, "TOOL_HANDLERS")).toThrow("Unclassified initializer");
  });
});
