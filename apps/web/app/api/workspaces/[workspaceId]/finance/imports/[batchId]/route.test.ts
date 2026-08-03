import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
const mocks = vi.hoisted(() => ({ detail: vi.fn(), edit: vi.fn(), review: vi.fn(), clarify: vi.fn(), apply: vi.fn(), actor: vi.fn(), demo: vi.fn(), error: vi.fn((value) => NextResponse.json({ error: value.code }, { status: value.status ?? 500 })) }));
class MockAppError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, applyFinanceReportImport: mocks.apply, getFinanceReportImport: mocks.detail,
  editFinanceReportImportCandidate: mocks.edit, rerunFinanceReportImportReconciliation: mocks.clarify, reviewFinanceReportImport: mocks.review }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.actor }));
vi.mock("@/lib/demo-guard", () => ({ checkApiDemoGuard: mocks.demo }));
vi.mock("@/lib/http", () => ({ handleRouteError: mocks.error, validateBody: async (request: NextRequest, schema: ZodType) => {
  let value; try { value = await request.json(); } catch { throw new MockAppError(400, "VALIDATION_ERROR", "Invalid JSON"); }
  const parsed = schema.safeParse(value); if (!parsed.success) throw new MockAppError(400, "VALIDATION_ERROR", "Invalid body"); return parsed.data;
} }));
const actor = { kind: "user", user: { id: "writer-1" } };
const context = { params: Promise.resolve({ workspaceId: "workspace-1", batchId: "batch-1" }) };
const request = (body: unknown, method = "PATCH") => new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports/batch-1", { method, body: JSON.stringify(body) });
describe("Finance import detail route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor); mocks.detail.mockResolvedValue({ id: "batch-1" }); mocks.edit.mockResolvedValue({ version: 2 }); mocks.review.mockResolvedValue({ version: 3 });
    mocks.clarify.mockResolvedValue({ batchId: "batch-1", version: 4, stage: "READY_FOR_REVIEW" });
    mocks.apply.mockResolvedValue({ batchId: "batch-1", version: 4, stage: "APPLIED", appliedCount: 1, appliedNow: 1, noOp: false,
      receipts: [{ candidateId: "candidate-1", id: "receipt-1", outcome: "CREATED", targetFactId: "fact-1", idempotencyKey: "key-1" }] }); });
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
  it("confirms only bounded currency and resolved scale at route-owned exact versions", async () => {
    const { PATCH } = await import("./route"); const body = { operation: "CLARIFY", expectedVersion: 3,
      candidateVersions: [{ id: " candidate-1 ", expectedVersion: 2 }], confirmedCurrency: " eur ", confirmedAmountScale: 1_000 };
    const response = await PATCH(request({ ...body, workspaceId: "other", extra: true }), context);
    expect(response.status).toBe(400); expect(mocks.clarify).not.toHaveBeenCalled();
    const accepted = await PATCH(request(body), context); expect(await accepted.json()).toEqual({ clarification: { batchId: "batch-1", version: 4, stage: "READY_FOR_REVIEW" } });
    expect(mocks.clarify).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", batchId: "batch-1",
      expectedVersion: 3, candidateVersions: [{ id: "candidate-1", expectedVersion: 2 }], confirmedCurrency: "eur", confirmedAmountScale: 1_000 });
    const duplicate = { ...body, candidateVersions: [{ id: "candidate-1", expectedVersion: 2 }, { id: " candidate-1 ", expectedVersion: 2 }] };
    expect((await PATCH(request(duplicate), context)).status).toBe(400); expect(mocks.clarify).toHaveBeenCalledTimes(1);
  });
  it("applies exact route-owned candidate versions and returns canonical receipts", async () => {
    const { POST } = await import("./route"); const body = { expectedVersion: 3, candidateVersions: [{ id: " candidate-1 ", expectedVersion: 2 }] };
    const response = await POST(request(body, "POST"), context); const result = await response.json();
    expect(response.status).toBe(200); expect(result.application).toMatchObject({ batchId: "batch-1", stage: "APPLIED", receipts: [{ id: "receipt-1" }] });
    expect(mocks.demo).toHaveBeenCalledWith("workspace-1"); expect(mocks.apply).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3, candidateVersions: [{ id: "candidate-1", expectedVersion: 2 }] });
  });
  it("rejects malformed or unbounded application bodies before dispatch", async () => {
    const { POST } = await import("./route"); const invalid = [
      { expectedVersion: 0, candidateVersions: [{ id: "candidate-1", expectedVersion: 1 }] },
      { expectedVersion: 1, candidateVersions: [] },
      { expectedVersion: 1, candidateVersions: [{ id: " ", expectedVersion: 1 }] },
      { expectedVersion: 1, candidateVersions: [{ id: "candidate-1", expectedVersion: 2_147_483_647 }] },
      { expectedVersion: 1, candidateVersions: [{ id: "candidate-1", expectedVersion: 1 }, { id: " candidate-1 ", expectedVersion: 1 }] },
      { expectedVersion: 1, candidateVersions: [{ id: "candidate-1", expectedVersion: 1 }], workspaceId: "other" },
      { expectedVersion: 1, candidateVersions: Array.from({ length: 1_001 }, (_, index) => ({ id: `candidate-${index}`, expectedVersion: 1 })) },
    ];
    for (const body of invalid) expect((await POST(request(body, "POST"), context)).status).toBe(400);
    const malformed = new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports/batch-1", { method: "POST", body: "{" });
    expect((await POST(malformed, context)).status).toBe(400); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("stops before application when actor or demo access fails and maps domain conflicts", async () => {
    const { POST } = await import("./route"); const body = { expectedVersion: 1, candidateVersions: [{ id: "candidate-1", expectedVersion: 1 }] };
    mocks.actor.mockRejectedValueOnce(new MockAppError(401, "UNAUTHORIZED", "No session"));
    expect((await POST(request(body, "POST"), context)).status).toBe(401); expect(mocks.demo).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
    mocks.demo.mockRejectedValueOnce(new MockAppError(403, "DEMO_READ_ONLY", "Read only"));
    expect((await POST(request(body, "POST"), context)).status).toBe(403); expect(mocks.apply).not.toHaveBeenCalled();
    mocks.apply.mockRejectedValueOnce(new MockAppError(409, "FINANCE_REPORT_APPLICATION_CONFLICT", "Refresh"));
    const conflict = await POST(request(body, "POST"), context); expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "FINANCE_REPORT_APPLICATION_CONFLICT" });
  });
});
