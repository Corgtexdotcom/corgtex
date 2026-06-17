import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  postDeliberationEntry,
  resolveDeliberationEntry,
  listDeliberationEntries,
  listDeliberationEntriesForParents,
} from "./deliberation";

describe("deliberation", () => {
  let workspaceId: string;
  let adminActor: AppActor;
  let adminUserId: string;
  let memberActor: AppActor;
  let memberId: string;
  let proposalId: string;
  let actionId: string;

  beforeEach(async () => {
    const ws = await prisma.workspace.create({
      data: { name: "Test WS", slug: `test-${Date.now()}-${Math.random()}` }
    });
    workspaceId = ws.id;

    const adminUser = await prisma.user.create({
      data: { email: `admin-${Date.now()}-${Math.random()}@test.com`, passwordHash: "x", displayName: "Admin" }
    });
    adminUserId = adminUser.id;
    await prisma.member.create({
      data: { workspaceId, userId: adminUser.id, role: "ADMIN" }
    });
    adminActor = { kind: "user", user: adminUser };

    const memberUser = await prisma.user.create({
      data: { email: `member-${Date.now()}-${Math.random()}@test.com`, passwordHash: "x", displayName: "Member" }
    });
    const member = await prisma.member.create({
      data: { workspaceId, userId: memberUser.id, role: "CONTRIBUTOR" }
    });
    memberId = member.id;
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

    const action = await prisma.action.create({
      data: {
        workspaceId,
        authorUserId: adminUser.id,
        title: "Test Action",
        bodyMd: "body",
        status: "OPEN",
        isPrivate: false,
        publishedAt: new Date(),
      },
    });
    actionId = action.id;
  });

  it("posts an entry and lists it", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "What is this?"
    });

    expect(entry.entryType).toBe("REACTION");
    expect(entry.bodyMd).toBe("What is this?");
    expect(entry.parentVersion).toBe(1);

    const list = await listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].author.displayName).toBe("Member");
    expect(list[0].parentVersion).toBe(1);
  });

  it("requires bodyMd for OBJECTION", async () => {
    await expect(postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "OBJECTION",
      bodyMd: ""
    })).rejects.toThrow(/Deliberation entries require a non-empty bodyMd/);
  });

  it("allows multiple reaction entries", async () => {
    const entry1 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "First reaction"
    });

    const entry2 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Second reaction"
    });

    expect(entry1.id).not.toBe(entry2.id);

    const list = await listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    });
    expect(list.length).toBe(2);
  });

  it("lists deliberation entries for multiple parents in one grouped read", async () => {
    const secondProposal = await prisma.proposal.create({
      data: {
        workspaceId,
        authorUserId: adminUserId,
        title: "Second Proposal",
        bodyMd: "body",
      }
    });
    const firstEntry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "First proposal reaction"
    });
    const secondEntry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: secondProposal.id,
      entryType: "OBJECTION",
      bodyMd: "Second proposal objection"
    });
    const laterFirstEntry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Later first proposal reaction"
    });
    const entriesByParent = await listDeliberationEntriesForParents(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentIds: [proposalId, secondProposal.id, "missing-parent"],
    });

    expect(entriesByParent.get(proposalId)?.map((entry) => entry.id)).toEqual([firstEntry.id, laterFirstEntry.id]);
    expect(entriesByParent.get(secondProposal.id)?.map((entry) => entry.id)).toEqual([secondEntry.id]);
    expect(entriesByParent.get("missing-parent")).toEqual([]);
    expect(entriesByParent.get(proposalId)?.[0].author.displayName).toBe("Member");
  });

  it("returns an empty parent map for empty parent ids", async () => {
    const entriesByParent = await listDeliberationEntriesForParents(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentIds: [],
    });

    expect(entriesByParent.size).toBe(0);
  });

  it("accepts targetMemberId for a reaction", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Please review this.",
      targetMemberId: memberId
    });
    expect(entry.targetMemberId).toBe(memberId);
  });

  it("posts an action deliberation entry with the action version", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "ACTION",
      parentId: actionId,
      entryType: "REACTION",
      bodyMd: "Daniel said no more action is needed yet; the team is waiting on owner confirmation.",
    });

    expect(entry.parentType).toBe("ACTION");
    expect(entry.parentId).toBe(actionId);
    expect(entry.parentVersion).toBe(1);
  });

  it("resolves an entry", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "OBJECTION",
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
      entryType: "REACTION",
      bodyMd: "Needs a change."
    });

    await expect(resolveDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Not allowed"
    })).rejects.toThrow(/Only the entry author, parent author, or a workspace admin can resolve/);
  });
});
