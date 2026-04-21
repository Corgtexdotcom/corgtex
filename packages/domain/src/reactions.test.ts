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
      findUniqueOrThrow: vi.fn(),
    },
    proposal: {
      findUniqueOrThrow: vi.fn(),
    }
  },
  AppError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
}));

describe("postReaction", () => {
  it("allows posting a support reaction", async () => {
    vi.mocked(prisma.proposal.findUniqueOrThrow).mockResolvedValueOnce({ workspaceId: "ws1" } as any);
    vi.mocked(prisma.proposalReaction.create).mockResolvedValueOnce({ id: "r1", reaction: "SUPPORT" } as any);
    const result = await postReaction({ id: "user1", getWorkspaceRole: () => "MEMBER" } as any, {
      workspaceId: "ws1",
      proposalId: "p1",
      reaction: "SUPPORT",
    });
    expect(result.reaction).toBe("SUPPORT");
  });
});

describe("resolveReaction", () => {
  it("allows author to resolve an objection", async () => {
    vi.mocked(prisma.proposalReaction.findUniqueOrThrow).mockResolvedValueOnce({
      id: "r1", proposal: { workspaceId: "ws1", authorId: "user1" }, reaction: "OBJECTION"
    } as any);
    vi.mocked(prisma.proposalReaction.update).mockResolvedValueOnce({ id: "r1", resolvedAt: new Date() } as any);
    
    const result = await resolveReaction({ id: "user1" } as any, {
      workspaceId: "ws1", reactionId: "r1", resolvedNote: "fixed"
    });
    expect(result.resolvedAt).toBeDefined();
  });
});
