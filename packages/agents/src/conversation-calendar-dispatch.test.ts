import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const availability = vi.hoisted(() => vi.fn());
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/agent-operation-capabilities"),
  ...await import("../../domain/src/agent-operation-authorization"),
  getCalendarAvailability: availability,
  refreshOAuthTokenIfNeeded: vi.fn(),
}));
import { checkCalendarAvailability, checkCalendarAvailabilityTool } from "./tools/calendar";
import { guardConversationToolHandlers } from "./conversation-capabilities";

// Exercise the reserved module's actual handler and wrapper expressions without
// adding a production export or enabling unsupported Calendar source receipts.
const source = (path: string) => ts.createSourceFile(path,
  readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const conversation = source("./conversation.ts");
const lineage = source("./conversation-tool-lineage.ts");
function declaration(file: ts.SourceFile, name: string): ts.VariableDeclaration | ts.FunctionDeclaration {
  let found: ts.VariableDeclaration | ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`Missing source declaration: ${name}`);
  return found;
}
function evaluate(expression: string, bindings: Record<string, unknown> = {}) {
  const javascript = ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return runInNewContext(javascript, bindings);
}
function variable(file: ts.SourceFile, name: string, bindings: Record<string, unknown> = {}) {
  const node = declaration(file, name);
  if (!ts.isVariableDeclaration(node) || !node.initializer) throw new Error(`Missing initializer: ${name}`);
  return evaluate(node.initializer.getText(file), bindings);
}
const raw = declaration(conversation, "RAW_TOOL_HANDLERS") as ts.VariableDeclaration;
const handlers = raw.initializer as ts.ObjectLiteralExpression;
const calendar = handlers.properties.find(property => property.name?.getText(conversation) === "check_calendar_availability");
if (!calendar || !ts.isPropertyAssignment(calendar)) throw new Error("Missing availability dispatch");
const rawHandler = evaluate(calendar.initializer.getText(conversation), { checkCalendarAvailability });
const trustedRead = declaration(lineage, "executeTrustedConversationReadTool");
const executeTrustedConversationReadTool = evaluate(trustedRead.getText(lineage).replace(/^export\s+/, ""), {
  trustedReadTools: variable(lineage, "trustedReadTools"),
});
const wrapped = variable(conversation, "TOOL_HANDLERS", {
  RAW_TOOL_HANDLERS: { check_calendar_availability: rawHandler },
  guardConversationToolHandlers,
  conversationCollector: evaluate(declaration(conversation, "conversationCollector").getText(conversation)),
  CONVERSATION_MUTATION_TOOLS: variable(conversation, "CONVERSATION_MUTATION_TOOLS"),
  executeTrustedConversationReadTool,
});

const actor: AppActor = { kind: "user", user: { id: "actual-user", email: "synthetic@example.test", displayName: null } };
const args = { provider: "MICROSOFT", emails: ["synthetic@example.test"], timeMin: "2026-10-14T09:00:00Z", timeMax: "2026-10-14T17:00:00Z" };
const context = () => ({ workspaceId: "synthetic-workspace", userId: "untrusted-context-user", collector: { assertReadable: vi.fn() } });

beforeEach(() => { vi.clearAllMocks(); availability.mockResolvedValue({ provider: "MICROSOFT", schedules: {} }); });

describe("bounded Calendar availability dispatch", () => {
  it("propagates the actual authenticated actor and explicit provider through the real raw handler", async () => {
    const result = await rawHandler(actor, context(), args);
    expect(result).toEqual({ provider: "MICROSOFT", schedules: {} });
    expect(availability).toHaveBeenCalledWith(actor, { workspaceId: "synthetic-workspace", ...args });
    expect(availability.mock.calls[0][0]).toBe(actor);
    expect(checkCalendarAvailabilityTool.function.parameters).toMatchObject({
      properties: { provider: { type: "string", enum: ["GOOGLE", "MICROSOFT"] } },
      required: expect.arrayContaining(["provider"]),
    });
  });

  it("retains the actual SOURCE wrapper's unsupported-receipt denial", async () => {
    const ctx = context();
    const result = await wrapped.check_calendar_availability(actor, ctx, args);
    expect(result).toMatchObject({ success: false, contentWithheld: true });
    expect(ctx.collector.assertReadable).toHaveBeenCalledOnce();
    expect(availability).not.toHaveBeenCalled();
  });

  it.each([{ operationScopes: [] }, { operationScopes: ["conversations:write"] }, { operationScopes: ["conversations:write", "meetings:read"] }])("retains operation-scoped denial for %j", async ({ operationScopes }) => {
    await expect(wrapped.check_calendar_availability(actor, { ...context(), operationScopes }, args)).rejects.toMatchObject({ status: 403 });
    expect(availability).not.toHaveBeenCalled();
  });

  it("retains credential/MCP denial before reaching the raw handler", async () => {
    const credential: AppActor = { kind: "agent", authProvider: "credential", label: "synthetic", credentialId: "synthetic-id",
      workspaceIds: ["synthetic-workspace"], scopes: ["conversations:write", "meetings:read"] };
    await expect(wrapped.check_calendar_availability(credential, context(), args)).rejects.toMatchObject({ status: 403 });
    expect(availability).not.toHaveBeenCalled();
  });
});
