import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { kind: "user", user: { id: "member-1" } },
  requirePageActor: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));

vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.requirePageActor }));
vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  requireWorkspaceMembership: mocks.requireWorkspaceMembership,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import { AppError } from "@corgtex/domain";
import { requireInstallerWorkspace } from "./installer-workspace";

describe("installer workspace access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePageActor.mockResolvedValue(mocks.actor);
    mocks.requireWorkspaceMembership.mockResolvedValue({ role: "MEMBER" });
  });

  it("checks the selected workspace even when the user can access another workspace", async () => {
    await requireInstallerWorkspace("selected-id");
    expect(mocks.requireWorkspaceMembership).toHaveBeenCalledWith({ actor: mocks.actor, workspaceId: "selected-id" });
    expect(mocks.requireWorkspaceMembership).toHaveBeenCalledTimes(1);
  });

  it("hides a foreign or missing workspace before rendering its installer", async () => {
    mocks.requireWorkspaceMembership.mockRejectedValue(new AppError(403, "FORBIDDEN", "foreign"));
    await expect(requireInstallerWorkspace("foreign-id")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("preserves operational errors instead of masking them as absent workspaces", async () => {
    mocks.requireWorkspaceMembership.mockRejectedValue(new AppError(503, "UNAVAILABLE", "database down"));
    await expect(requireInstallerWorkspace("selected-id")).rejects.toThrow("database down");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
