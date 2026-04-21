import { describe, expect, it, vi } from "vitest";
import { normalizeProposalReaction } from "./reactions";

describe("normalizeProposalReaction", () => {
  it("normalizes valid reactions", () => {
    expect(normalizeProposalReaction(" support ")).toBe("SUPPORT");
  });

  it("rejects blank reactions", () => {
    expect(() => normalizeProposalReaction("   ")).toThrowError("reaction is required.");
  });

  it("rejects overly long reactions", () => {
    expect(() => normalizeProposalReaction("a".repeat(33))).toThrowError("reaction must be 32 characters or fewer.");
  });
});

import { postReaction, resolveReaction } from "./reactions";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    proposalReaction: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
    },
    proposal: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
  AppError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "member1", role: "MEMBER" })
}));

describe("postReaction", () => {
  it("allows posting a support reaction", async () => {
    vi.mocked(prisma.proposal.findUnique).mockResolvedValueOnce({ workspaceId: "ws1" } as any);
    vi.mocked(prisma.proposalReaction.create).mockResolvedValueOnce({ id: "r1", reaction: "SUPPORT" } as any);
    const result = await postReaction({ kind: "user", user: { id: "user1", email: "user@example.com" }, getWorkspaceRole: () => "MEMBER" } as any, {
      workspaceId: "ws1",
      proposalId: "p1",
      reaction: "SUPPORT",
    });
    expect(result.reaction).toBe("SUPPORT");
  });
});

describe("resolveReaction", () => {
  it("allows author to resolve an objection", async () => {
    vi.mocked(prisma.proposalReaction.findUnique).mockResolvedValueOnce({
      id: "r1", proposal: { workspaceId: "ws1", authorUserId: "user1" }, reaction: "OBJECTION"
    } as any);
    vi.mocked(prisma.proposalReaction.update).mockResolvedValueOnce({ id: "r1", resolvedAt: new Date() } as any);
    
    const result = await resolveReaction({ kind: "user", user: { id: "user1", email: "user@example.com" } } as any, {
      workspaceId: "ws1", reactionId: "r1", resolvedNote: "fixed"
    });
    expect(result.resolvedAt).toBeDefined();
  });
});
