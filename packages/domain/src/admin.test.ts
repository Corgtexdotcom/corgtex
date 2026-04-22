import { describe, it, expect, vi } from "vitest";
import { listAllWorkspaces, adminTriggerPasswordReset } from "./admin";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    workspace: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("./password-reset", () => ({
  requestPasswordReset: vi.fn(),
}));

describe("admin", () => {
  it("rejects non-global admins", async () => {
    const actor: any = { kind: "user", user: { email: "test@example.com" } };
    await expect(listAllWorkspaces(actor)).rejects.toThrow();
  });

  it("allows global admin to list workspaces", async () => {
    const actor: any = { kind: "user", user: { email: "janbrezina@icloud.com" } };
    vi.mocked(prisma.workspace.findMany).mockResolvedValueOnce([]);
    const res = await listAllWorkspaces(actor);
    expect(res).toEqual([]);
  });
});
