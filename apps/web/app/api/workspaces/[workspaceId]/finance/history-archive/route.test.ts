import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), membership: vi.fn(), member: vi.fn(), archive: vi.fn(), get: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.actor }));
vi.mock("@corgtex/domain", () => ({
  AppError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
  requireWorkspaceMembership: mocks.membership,
}));
vi.mock("@corgtex/shared", () => ({ prisma: {
  member: { findFirst: mocks.member }, workspaceFeatureFlag: { findUnique: mocks.archive },
} }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: { get: mocks.get } }));
vi.mock("@/lib/http", () => ({ handleRouteError: (error: { status?: number; code?: string }) =>
  Response.json({ code: error.code ?? "INTERNAL_ERROR" }, { status: error.status ?? 500 }) }));

import { GET } from "./route";
const data = Buffer.from("synthetic preserved history");
const sha256 = createHash("sha256").update(data).digest("hex");
const run = (workspaceId = "workspace-1") => GET(new Request("https://example.invalid/archive") as never, { params: Promise.resolve({ workspaceId }) });

describe("financial history archive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.actor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    mocks.membership.mockResolvedValue({ role: "ADMIN", isActive: true });
    mocks.member.mockResolvedValue({ id: "member-1" });
    mocks.archive.mockResolvedValue({ enabled: true, config: { sha256, bytes: data.length } });
    mocks.get.mockResolvedValue({ data });
  });

  it("returns verified bytes with no caching or signed link to an active human admin", async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.member).toHaveBeenCalledWith(expect.objectContaining({ where: {
      workspaceId: "workspace-1", userId: "user-1", isActive: true, kind: "HUMAN", role: "ADMIN",
    } }));
    expect(mocks.get).toHaveBeenCalledWith(`imports/workspace-1/history/${sha256}.json.gz`);
  });

  it("denies agents even with support scopes", async () => {
    mocks.actor.mockResolvedValue({ kind: "agent", scopes: ["support:write"] });
    expect((await run()).status).toBe(403);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("denies inactive, nonadmin, system and nonmember operator identities before archive lookup", async () => {
    mocks.member.mockResolvedValue(null);
    expect((await run()).status).toBe(403);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("honors workspace scope failure", async () => {
    mocks.membership.mockRejectedValue({ status: 403, code: "FORBIDDEN" });
    expect((await run("other-workspace")).status).toBe(403);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([null, { enabled: false }, { enabled: true, config: { sha256: "../other", bytes: 1 } }])("rejects unavailable or invalid archive metadata", async (archive) => {
    mocks.archive.mockResolvedValue(archive);
    expect((await run()).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("does not return corrupted archive bytes", async () => {
    mocks.get.mockResolvedValue({ data: Buffer.from("corrupt") });
    expect((await run()).status).toBe(409);
  });
});
