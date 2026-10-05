import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ deleteSource: vi.fn(), resolveRequestActor: vi.fn() }));
class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
vi.mock("@corgtex/domain", () => mocks);
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.resolveRequestActor }));
vi.mock("@/lib/http", () => ({ handleRouteError: (error: AppError) => Response.json({ code: error.code }, { status: error.status ?? 500 }) }));
const actor = { kind: "user", user: { id: "admin" } };
const context = () => ({ params: Promise.resolve({ workspaceId: "workspace", sourceId: "source" }) });
const request = () => new Request("http://localhost/api/workspaces/workspace/brain/sources/source", { method: "DELETE" }) as never;

describe("Brain source removal API", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.resolveRequestActor.mockResolvedValue(actor); });
  it("returns a pending job and human review link without claiming deletion completed", async () => {
    mocks.deleteSource.mockResolvedValue({ id: "source", status: "pending", jobId: "job" });
    const { DELETE } = await import("./route");
    const result = await DELETE(request(), context());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({ ok: false, id: "source", status: "pending", jobId: "job",
      reviewUrl: "/workspaces/workspace/brain/sources?review=source" });
  });
  it("returns completed state for synchronous archival", async () => {
    mocks.deleteSource.mockResolvedValue({ id: "source", status: "archived" });
    const { DELETE } = await import("./route");
    expect(await (await DELETE(request(), context())).json()).toEqual({ ok: true, id: "source", status: "archived" });
  });
  it("propagates domain authorization failure without reporting success", async () => {
    mocks.deleteSource.mockRejectedValue(new AppError(403, "FORBIDDEN", "Admin required"));
    const { DELETE } = await import("./route");
    expect((await DELETE(request(), context())).status).toBe(403);
  });
});
