import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, envMock } = vi.hoisted(() => ({
  prismaMock: {
    session: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  envMock: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: envMock,
  prisma: prismaMock,
  hashPassword: vi.fn(),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  randomOpaqueToken: vi.fn(() => "token"),
  sha256: vi.fn((value: string) => `hash:${value}`),
  verifyPassword: vi.fn(),
}));

describe("resolveSessionActor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    prismaMock.session.findUnique.mockReset();
    prismaMock.session.updateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not rewrite lastSeenAt inside the throttle window", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session-1",
      expiresAt: new Date("2026-04-25T12:00:00.000Z"),
      lastSeenAt: new Date("2026-04-24T11:58:00.000Z"),
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    });

    const { resolveSessionActor } = await import("./auth");
    await expect(resolveSessionActor("token")).resolves.toEqual({
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    });

    expect(prismaMock.session.updateMany).not.toHaveBeenCalled();
  });

  it("updates lastSeenAt after the throttle window", async () => {
    prismaMock.session.findUnique.mockResolvedValue({
      id: "session-1",
      expiresAt: new Date("2026-04-25T12:00:00.000Z"),
      lastSeenAt: new Date("2026-04-24T11:50:00.000Z"),
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    });

    const { resolveSessionActor } = await import("./auth");
    await resolveSessionActor("token");

    expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        lastSeenAt: { lte: new Date("2026-04-24T11:55:00.000Z") },
      },
      data: {
        lastSeenAt: new Date("2026-04-24T12:00:00.000Z"),
      },
    });
  });
});
