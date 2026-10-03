import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), context: vi.fn(), feature: vi.fn() }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.actor }));
vi.mock("@/lib/workspace-feature-flags", () => ({ requireWorkspaceFeature: mocks.feature }));
vi.mock("@corgtex/domain", () => ({
  AppError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  buildSelectedRegionContext: mocks.context,
}));
vi.mock("@/lib/http", () => ({
  handleRouteError: (error: { status?: number; code?: string }) => Response.json({ code: error.code }, { status: error.status ?? 500 }),
}));
import { GET } from "./route";
const actor = { kind: "user", user: { id: "demo", email: "demo@jnj-demo.corgtex.app" } };
const request = (query = "?view=map-1&object=object-1") => new NextRequest("http://localhost/en/workspaces/demo/maps/context" + query);
const params = { params: Promise.resolve({ workspaceId: "demo" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(actor);
  mocks.feature.mockResolvedValue(undefined);
  mocks.context.mockResolvedValue({ objects: [{ id: "object-1" }] });
});
describe("selected-region GET", () => {
  it.each([actor, { kind: "user", user: { id: "member" } }])("serves authenticated readers with private no-store caching", async (reader) => {
    mocks.actor.mockResolvedValue(reader);
    const req = request();
    const response = await GET(req, params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.actor).toHaveBeenCalledWith(req);
    expect(mocks.feature).toHaveBeenCalledWith("demo", "CONTEXT_MAPS");
    expect(mocks.context).toHaveBeenCalledWith(reader, { workspaceId: "demo", mapViewId: "map-1", objectIds: ["object-1"], depth: 2 });
  });
  it.each([401, 403, 404])("returns authorization/object boundary failure %s without exposing graph data", async (status) => {
    const error = { status, code: "RESTRICTED" };
    if (status === 401) mocks.actor.mockRejectedValue(error);
    else mocks.context.mockRejectedValue(error);
    const response = await GET(request("?object=foreign-object"), params);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: "RESTRICTED" });
    if (status === 401) expect(mocks.context).not.toHaveBeenCalled();
  });
  it.each(["", "?" + new URLSearchParams(Array.from({ length: 201 }, () => ["object", "id"])).toString()])("rejects invalid selection bounds", async (query) => {
    expect((await GET(request(query), params)).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });
});
