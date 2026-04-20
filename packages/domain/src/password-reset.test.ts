import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockFindUnique = vi.fn();
const mockUpdateMany = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDeleteMany = vi.fn();
const mockUserUpdate = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
    passwordResetToken: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    session: {
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
  hashPassword: vi.fn((p: string) => `hashed:${p}`),
  randomOpaqueToken: vi.fn(() => "mock-token-abc123"),
  sha256: vi.fn((v: string) => `sha256:${v}`),
}));

import { requestPasswordReset, consumePasswordReset } from "./password-reset";
import { AppError } from "./errors";

describe("requestPasswordReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when user does not exist", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await requestPasswordReset("unknown@example.com");

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("generates a token for existing user", async () => {
    const user = { id: "user-1", email: "test@example.com", displayName: "Test" };
    mockFindUnique.mockResolvedValue(user);
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockCreate.mockResolvedValue({});

    const result = await requestPasswordReset("test@example.com");

    expect(result).not.toBeNull();
    expect(result!.token).toBe("mock-token-abc123");
    expect(result!.user).toEqual(user);
    expect(mockUpdateMany).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });

  it("throws on empty email", async () => {
    await expect(requestPasswordReset("")).rejects.toThrow(AppError);
  });
});

describe("consumePasswordReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on empty token", async () => {
    await expect(
      consumePasswordReset({ token: "", newPassword: "newpass123" }),
    ).rejects.toThrow(AppError);
  });

  it("throws on short password", async () => {
    await expect(
      consumePasswordReset({ token: "abc", newPassword: "short" }),
    ).rejects.toThrow(AppError);
  });

  it("throws when token not found", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      consumePasswordReset({ token: "bad-token", newPassword: "newpass123" }),
    ).rejects.toThrow("invalid or has expired");
  });

  it("throws when token already used", async () => {
    mockFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
    });

    await expect(
      consumePasswordReset({ token: "used-token", newPassword: "newpass123" }),
    ).rejects.toThrow("already been used");
  });

  it("throws when token expired", async () => {
    mockFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
    });

    await expect(
      consumePasswordReset({ token: "expired-token", newPassword: "newpass123" }),
    ).rejects.toThrow("expired");
  });

  it("resets password with valid token", async () => {
    mockFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
    });
    mockTransaction.mockResolvedValue([]);

    const result = await consumePasswordReset({
      token: "valid-token",
      newPassword: "newpass123",
    });

    expect(result).toEqual({ success: true });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
