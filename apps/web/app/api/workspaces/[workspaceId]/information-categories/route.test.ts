import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { configureInformationCategory, classifyInformationSource, resolveRequestActor } = vi.hoisted(() => ({
  configureInformationCategory: vi.fn(), classifyInformationSource: vi.fn(), resolveRequestActor: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor }));
vi.mock("@corgtex/domain", () => ({ configureInformationCategory, classifyInformationSource,
  AppError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
vi.mock("@corgtex/shared", () => ({ isDatabaseUnavailableError: () => false }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: vi.fn() }));
import { PATCH, POST } from "./route";

const actor = { kind: "user", user: { id: "admin-1" } };
const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
const policy = { category: "FINANCE", isRestricted: true, allowedRoleIds: ["role-1"], allowedCircleIds: [] };
const source = { kind: "Document", id: "document-1", category: "FINANCE" };
function request(method: string, rawBody: string) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/information-categories", {
    method, body: rawBody, headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  resolveRequestActor.mockResolvedValue(actor);
  configureInformationCategory.mockResolvedValue({ category: "FINANCE" });
  classifyInformationSource.mockResolvedValue({ id: "document-1", informationCategory: "FINANCE" });
});

describe.each([{ method: "POST", handler: POST, body: policy, domain: configureInformationCategory },
  { method: "PATCH", handler: PATCH, body: source, domain: classifyInformationSource }])("information categories $method", ({ method, handler, body, domain }) => {
  it.each(["null", "[]", "[{}]", "42", "true", '\"text\"', "{bad json", ""])("rejects invalid top-level JSON before domain mutation: %s", async rawBody => {
    const response = await handler(request(method, rawBody), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(configureInformationCategory).not.toHaveBeenCalled();
    expect(classifyInformationSource).not.toHaveBeenCalled();
  });
  it("preserves the workspace, actor, audience and selected source for valid input", async () => {
    const response = await handler(request(method, JSON.stringify(body)), context);
    expect(response.status).toBe(200);
    expect(domain).toHaveBeenCalledExactlyOnceWith(actor, { workspaceId: "workspace-1", ...body });
  });
  it("preserves membership and audience authorization errors", async () => {
    domain.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403, code: "FORBIDDEN" }));
    const response = await handler(request(method, JSON.stringify(body)), context);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });
});

it.each([undefined, "", null, []])("rejects missing or invalid source identity before classification: %s", async id => {
  const response = await PATCH(request("PATCH", JSON.stringify({ ...source, id })), context);
  expect(response.status).toBe(400);
  expect(classifyInformationSource).not.toHaveBeenCalled();
});

it("rejects an invalid policy audience before configuration", async () => {
  const response = await POST(request("POST", JSON.stringify({ ...policy, allowedRoleIds: [null] })), context);
  expect(response.status).toBe(400);
  expect(configureInformationCategory).not.toHaveBeenCalled();
});
