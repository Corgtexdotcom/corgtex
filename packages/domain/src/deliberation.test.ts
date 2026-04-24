import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { postDeliberationEntry, resolveDeliberationEntry, listDeliberationEntries } from "./deliberation";

describe("deliberation", () => {
  let workspaceId: string;
  let adminActor: AppActor;
  let memberActor: AppActor;
  let proposalId: string;

  beforeEach(async () => {
    const ws = await prisma.workspace.create({
      data: { name: "Test WS", slug: `test-${Date.now()}-${Math.random()}` }
    });
    workspaceId = ws.id;

    const adminUser = await prisma.user.create({
      data: { email: `admin-${Date.now()}-${Math.random()}@test.com`, passwordHash: "x", displayName: "Admin" }
    });
    await prisma.member.create({
      data: { workspaceId, userId: adminUser.id, role: "ADMIN" }
    });
    adminActor = { kind: "user", user: adminUser };

    const memberUser = await prisma.user.create({
      data: { email: `member-${Date.now()}-${Math.random()}@test.com`, passwordHash: "x", displayName: "Member" }
    });
    await prisma.member.create({
      data: { workspaceId, userId: memberUser.id, role: "CONTRIBUTOR" }
    });
    memberActor = { kind: "user", user: memberUser };

    const proposal = await prisma.proposal.create({
      data: {
        workspaceId,
        authorUserId: adminUser.id,
        title: "Test Proposal",
        bodyMd: "body"
      }
    });
    proposalId = proposal.id;
  });

  it("posts an entry and lists it", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "QUESTION",
      bodyMd: "What is this?"
    });

    expect(entry.entryType).toBe("QUESTION");
    expect(entry.bodyMd).toBe("What is this?");

    const list = await listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].author.displayName).toBe("Member");
  });

  it("requires bodyMd for OBJECTION", async () => {
    await expect(postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "OBJECTION",
      bodyMd: ""
    })).rejects.toThrow(/Objections require a non-empty bodyMd/);
  });

  it("deduplicates SUPPORT entries", async () => {
    const entry1 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "SUPPORT"
    });

    const entry2 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "SUPPORT"
    });

    expect(entry1.id).toBe(entry2.id);

    const list = await listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    });
    expect(list.length).toBe(1);
  });

  it("accepts targetMemberId for ADVICE_REQUEST", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "ADVICE_REQUEST",
      targetMemberId: "some-member-id"
    });
    expect(entry.targetMemberId).toBe("some-member-id");
  });

  it("resolves an entry", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "CONCERN",
      bodyMd: "I am concerned."
    });

    const resolved = await resolveDeliberationEntry(adminActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Fixed it"
    });

    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedNote).toBe("Fixed it");
  });

  it("prevents resolving by non-admin non-author", async () => {
    const entry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "QUESTION",
    });

    await expect(resolveDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Not allowed"
    })).rejects.toThrow(/Only the entry author, parent author, or a workspace admin can resolve/);
  });
});
