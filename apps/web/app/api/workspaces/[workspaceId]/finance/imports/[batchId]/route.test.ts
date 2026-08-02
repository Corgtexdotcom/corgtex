import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
const mocks = vi.hoisted(() => ({ detail: vi.fn(), edit: vi.fn(), review: vi.fn(), actor: vi.fn(), demo: vi.fn(), error: vi.fn((value) => NextResponse.json({ error: value.code }, { status: value.status ?? 500 })) }));
class MockAppError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, getFinanceReportImport: mocks.detail, editFinanceReportImportCandidate: mocks.edit, reviewFinanceReportImport: mocks.review }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.actor }));
vi.mock("@/lib/demo-guard", () => ({ checkApiDemoGuard: mocks.demo }));
vi.mock("@/lib/http", () => ({ handleRouteError: mocks.error, validateBody: async (request: NextRequest, schema: ZodType) => {
  let value; try { value = await request.json(); } catch { throw new MockAppError(400, "VALIDATION_ERROR", "Invalid JSON"); }
  const parsed = schema.safeParse(value); if (!parsed.success) throw new MockAppError(400, "VALIDATION_ERROR", "Invalid body"); return parsed.data;
} }));
const actor = { kind: "user", user: { id: "writer-1" } };
const context = { params: Promise.resolve({ workspaceId: "workspace-1", batchId: "batch-1" }) };
const request = (body: unknown) => new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports/batch-1", { method: "PATCH", body: JSON.stringify(body) });
describe("Finance import detail route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor); mocks.detail.mockResolvedValue({ id: "batch-1" }); mocks.edit.mockResolvedValue({ version: 2 }); mocks.review.mockResolvedValue({ version: 3 }); });
  it("returns the reader-authorized batch detail", async () => {
    const { GET } = await import("./route"); const response = await GET(new NextRequest("http://localhost/api"), context);
    expect(await response.json()).toEqual({ batch: { id: "batch-1" } }); expect(mocks.detail).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", batchId: "batch-1" });
  });
  it("validates and dispatches edits and both bulk choices behind the demo guard", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(request({ operation: "EDIT", candidateId: "candidate-1", expectedVersion: 1, expectedCandidateVersion: 1, amountCents: 100 }), context)).status).toBe(200);
    for (const operation of ["APPROVE", "REJECT", "APPROVE_VERIFIED", "APPROVE_ALL"]) await PATCH(request({ operation, expectedVersion: 1,
      candidateId: ["APPROVE", "REJECT"].includes(operation) ? "candidate-1" : undefined, candidateVersions: [{ id: "candidate-1", expectedVersion: 1 }],
      acceptWarnings: operation === "APPROVE_ALL" }), context);
    expect(mocks.demo).toHaveBeenCalledTimes(5); expect(mocks.edit).toHaveBeenCalled();
    expect(mocks.review.mock.calls.map((call) => call[1].mode)).toEqual(["APPROVE", "REJECT", "APPROVE_VERIFIED", "APPROVE_ALL"]);
  });
  it("maps malformed review bodies to a sanitized validation error", async () => {
    const { PATCH } = await import("./route"); const response = await PATCH(request({ operation: "APPROVE_ALL", expectedVersion: 0 }), context);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "VALIDATION_ERROR" }); expect(mocks.review).not.toHaveBeenCalled();
  });
});
