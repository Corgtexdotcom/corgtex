import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import {
  listDeliberationEntries,
  listDeliberationEntriesForParents,
  postDeliberationEntry,
  resolveDeliberationEntry,
  updateDeliberationEntry,
} from "./deliberation";

const { prismaMock, state } = vi.hoisted(() => {
  type UserRecord = { id: string; displayName?: string | null; email?: string | null };
  type MemberRecord = { id: string; workspaceId: string; userId: string; role: string; isActive: boolean };
  type EntryRecord = {
    id: string;
    workspaceId: string;
    parentType: string;
    parentId: string;
    parentVersion: number | null;
    authorUserId: string;
    entryType: string;
    bodyMd: string | null;
    targetMemberId: string | null;
    targetCircleId: string | null;
    adviceRequestId: string | null;
    resolvedAt: Date | null;
    resolvedNote: string | null;
    createdAt: Date;
  };

  const store = {
    users: new Map<string, UserRecord>(),
    members: new Map<string, MemberRecord>(),
    proposals: new Map<string, { id: string; workspaceId: string; authorUserId: string; version: number; isPrivate?: boolean }>(),
    tensions: new Map<string, { id: string; workspaceId: string; authorUserId: string; assigneeMemberId: string | null; title: string; version: number; isPrivate?: boolean }>(),
    actions: new Map<string, { id: string; workspaceId: string; authorUserId: string; assigneeMemberId: string | null; version: number; isPrivate?: boolean }>(),
    circles: new Map<string, { id: string; workspaceId: string; archivedAt: Date | null }>(),
    roleAssignments: [] as Array<{ memberId: string; circleId: string; expiresAt: Date | null }>,
    adviceRequests: new Map<string, { id: string; workspaceId: string; status: string; process: { subjectType: string; subjectId: string } }>(),
    entries: [] as EntryRecord[],
    auditLogs: [] as any[],
    events: [] as any[],
    notifications: [] as any[],
    notificationPreferences: [] as any[],
    nextEntry: 1,
  };

  function includeEntry(entry: EntryRecord) {
    const author = store.users.get(entry.authorUserId) ?? null;
    const targetMember = entry.targetMemberId ? store.members.get(entry.targetMemberId) : null;
    const targetUser = targetMember ? store.users.get(targetMember.userId) : null;
    return {
      ...entry,
      author,
      targetCircle: null,
      targetMember: targetMember && targetUser
        ? { ...targetMember, user: targetUser }
        : null,
    };
  }

  function matchesEntryWhere(entry: EntryRecord, where: any) {
    if (where.workspaceId && entry.workspaceId !== where.workspaceId) return false;
    if (where.parentType && entry.parentType !== where.parentType) return false;
    if (where.parentId) {
      if (typeof where.parentId === "string" && entry.parentId !== where.parentId) return false;
      if (where.parentId.in && !where.parentId.in.includes(entry.parentId)) return false;
    }
    return true;
  }

  const tx = {
    member: {
      findUnique: vi.fn(async ({ where }: any) => store.members.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        return Array.from(store.members.values()).find((member) => (
          (!where.id || member.id === where.id)
            && (!where.workspaceId || member.workspaceId === where.workspaceId)
            && (!where.userId || member.userId === where.userId)
            && (where.isActive === undefined || member.isActive === where.isActive)
        )) ?? null;
      }),
      findMany: vi.fn(async ({ where, include, select }: any) => {
        return Array.from(store.members.values())
          .filter((member) => (
            (!where.workspaceId || member.workspaceId === where.workspaceId)
              && (!where.userId?.in || where.userId.in.includes(member.userId))
              && (where.isActive === undefined || member.isActive === where.isActive)
          ))
          .map((member) => {
            if (include?.user) return { ...member, user: store.users.get(member.userId) };
            if (select?.userId) return { userId: member.userId };
            return member;
          });
      }),
    },
    circle: {
      findUnique: vi.fn(async ({ where }: any) => store.circles.get(where.id) ?? null),
    },
    roleAssignment: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: any) => store.roleAssignments
        .filter((assignment) => (
          assignment.circleId === where.role?.circleId
            && (!assignment.expiresAt || assignment.expiresAt > new Date())
        ))
        .map((assignment) => {
          const member = store.members.get(assignment.memberId)!;
          return { member: { userId: member.userId } };
        })),
    },
    proposal: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const proposal = Array.from(store.proposals.values()).find((item) => (
          item.id === where.id && item.workspaceId === where.workspaceId
        )) ?? null;
        if (!proposal || !select) return proposal;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (proposal as any)[field]]));
      }),
      findUnique: vi.fn(async ({ where, select }: any) => {
        const proposal = store.proposals.get(where.id) ?? null;
        if (!proposal || !select) return proposal;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (proposal as any)[field]]));
      }),
    },
    action: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const action = Array.from(store.actions.values()).find((item) => (
          item.id === where.id && item.workspaceId === where.workspaceId
        )) ?? null;
        if (!action || !select) return action;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (action as any)[field]]));
      }),
      findUnique: vi.fn(async ({ where, select }: any) => {
        const action = store.actions.get(where.id) ?? null;
        if (!action || !select) return action;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (action as any)[field]]));
      }),
    },
    tension: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const tension = Array.from(store.tensions.values()).find((item) => (
          item.id === where.id && item.workspaceId === where.workspaceId
        )) ?? null;
        if (!tension || !select) return tension;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (tension as any)[field]]));
      }),
      findUnique: vi.fn(async ({ where, select }: any) => {
        const tension = store.tensions.get(where.id) ?? null;
        if (!tension || !select) return tension;
        return Object.fromEntries(Object.keys(select).map((field) => [field, (tension as any)[field]]));
      }),
    },
    meeting: {
      findUnique: vi.fn(async () => null),
    },
    brainArticle: {
      findUnique: vi.fn(async () => null),
    },
    adviceRequest: {
      findUnique: vi.fn(async ({ where }: any) => store.adviceRequests.get(where.id) ?? null),
    },
    deliberationEntry: {
      create: vi.fn(async ({ data }: any) => {
        const entry = {
          id: `entry-${store.nextEntry++}`,
          resolvedAt: null,
          resolvedNote: null,
          createdAt: new Date(`2026-06-17T12:00:${String(store.nextEntry).padStart(2, "0")}.000Z`),
          targetMemberId: null,
          targetCircleId: null,
          adviceRequestId: null,
          ...data,
        } as EntryRecord;
        store.entries.push(entry);
        return entry;
      }),
      findUnique: vi.fn(async ({ where }: any) => store.entries.find((entry) => entry.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => store.entries.filter((entry) => matchesEntryWhere(entry, where)).map(includeEntry)),
      update: vi.fn(async ({ where, data }: any) => {
        const index = store.entries.findIndex((item) => item.id === where.id);
        const entry = store.entries[index];
        if (!entry) return null;
        const updated = { ...entry, ...data };
        store.entries[index] = updated;
        return updated;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        store.auditLogs.push(data);
        return data;
      }),
      findFirst: vi.fn(async ({ where }: any) => store.auditLogs.find((log) => (
        (!where.workspaceId || log.workspaceId === where.workspaceId)
          && (!where.action || log.action === where.action)
          && (!where.entityId || log.entityId === where.entityId)
      )) ?? null),
    },
    event: {
      createMany: vi.fn(async ({ data }: any) => {
        store.events.push(...data);
        return { count: data.length };
      }),
    },
    notificationPreference: {
      findMany: vi.fn(async ({ where }: any) => store.notificationPreferences.filter((preference) => (
        where.userId.in.includes(preference.userId) && where.notifType.in.includes(preference.notifType)
      ))),
    },
    notification: {
      createMany: vi.fn(async ({ data }: any) => {
        store.notifications.push(...data);
        return { count: data.length };
      }),
    },
  };

  return {
    state: store,
    prismaMock: {
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }: { actor: AppActor; workspaceId: string }) => {
    if (actor.kind !== "user") return null;
    return Array.from(state.members.values()).find((member) => (
      member.workspaceId === workspaceId && member.userId === actor.user.id && member.isActive
    )) ?? null;
  }),
  actorUserIdForWorkspace: vi.fn(async (actor: AppActor) => actor.kind === "user" ? actor.user.id : "agent-user"),
}));

describe("deliberation", () => {
  const workspaceId = "ws-1";
  const proposalId = "proposal-1";
  const actionId = "action-1";
  const adminActor = { kind: "user", user: { id: "admin-user", email: "admin@example.com", displayName: "Admin" } } as AppActor;
  const memberActor = { kind: "user", user: { id: "member-user", email: "member@example.com", displayName: "Member" } } as AppActor;
  const otherActor = { kind: "user", user: { id: "other-user", email: "other@example.com", displayName: "Other" } } as AppActor;
  const memberId = "member-1";

  beforeEach(() => {
    vi.clearAllMocks();
    state.users.clear();
    state.members.clear();
    state.proposals.clear();
    state.tensions.clear();
    state.actions.clear();
    state.circles.clear();
    state.roleAssignments.length = 0;
    state.adviceRequests.clear();
    state.entries.length = 0;
    state.auditLogs.length = 0;
    state.events.length = 0;
    state.notifications.length = 0;
    state.notificationPreferences.length = 0;
    state.nextEntry = 1;

    state.users.set("admin-user", { id: "admin-user", displayName: "Admin", email: "admin@example.com" });
    state.users.set("member-user", { id: "member-user", displayName: "Member", email: "member@example.com" });
    state.users.set("other-user", { id: "other-user", displayName: "Other", email: "other@example.com" });
    state.members.set("admin-member", { id: "admin-member", workspaceId, userId: "admin-user", role: "ADMIN", isActive: true });
    state.members.set(memberId, { id: memberId, workspaceId, userId: "member-user", role: "CONTRIBUTOR", isActive: true });
    state.members.set("other-member", { id: "other-member", workspaceId, userId: "other-user", role: "CONTRIBUTOR", isActive: true });
    state.proposals.set(proposalId, { id: proposalId, workspaceId, authorUserId: "admin-user", version: 1 });
    state.tensions.set("tension-1", { id: "tension-1", workspaceId, authorUserId: "admin-user", assigneeMemberId: null, title: "Clarify launch owner", version: 1 });
    state.actions.set(actionId, { id: actionId, workspaceId, authorUserId: "admin-user", assigneeMemberId: memberId, version: 1 });
    state.adviceRequests.set("request-1", {
      id: "request-1",
      workspaceId,
      status: "ACTIVE",
      process: {
        subjectType: "PROPOSAL",
        subjectId: proposalId,
      },
    });
  });

  it("posts an entry and lists it", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "What is this?",
    });

    expect(entry.entryType).toBe("REACTION");
    expect(entry.bodyMd).toBe("What is this?");
    expect(entry.parentVersion).toBe(1);

    const list = await listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].author.displayName).toBe("Member");
    expect(list[0].parentVersion).toBe(1);
  });

  it("notifies a selected person target when posting a deliberation entry", async () => {
    const entry = await postDeliberationEntry(otherActor, {
      workspaceId,
      parentType: "TENSION",
      parentId: "tension-1",
      entryType: "REACTION",
      bodyMd: "@Member can you weigh in before Friday?",
      targetMemberId: memberId,
    });

    expect(state.notifications).toEqual([
      expect.objectContaining({
        workspaceId,
        userId: "member-user",
        type: "deliberation.mention",
        entityType: "Tension",
        entityId: "tension-1",
        title: "Other mentioned you in a tension: Clarify launch owner",
        bodyMd: "@Member can you weigh in before Friday?",
      }),
    ]);
    expect(state.notifications[0]).not.toMatchObject({ userId: "other-user" });
    expect(entry.targetMemberId).toBe(memberId);
  });

  it("notifies a uniquely resolved manual @mention", async () => {
    await postDeliberationEntry(otherActor, {
      workspaceId,
      parentType: "TENSION",
      parentId: "tension-1",
      entryType: "REACTION",
      bodyMd: "Looping in @Member because this affects onboarding.",
    });

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      userId: "member-user",
      type: "deliberation.mention",
      entityType: "Tension",
      entityId: "tension-1",
    });
  });

  it("does not notify ambiguous manual @mentions", async () => {
    state.users.set("duplicate-user", { id: "duplicate-user", displayName: "Member", email: "duplicate@example.com" });
    state.members.set("duplicate-member", { id: "duplicate-member", workspaceId, userId: "duplicate-user", role: "CONTRIBUTOR", isActive: true });

    await postDeliberationEntry(otherActor, {
      workspaceId,
      parentType: "TENSION",
      parentId: "tension-1",
      entryType: "REACTION",
      bodyMd: "Looping in @Member because there are two possible matches.",
    });

    expect(state.notifications).toEqual([]);
  });

  it("notifies selected target circle members without resolving the circle label as a user mention", async () => {
    state.users.set("finance-user", { id: "finance-user", displayName: "Finance", email: "finance@example.com" });
    state.members.set("finance-member", { id: "finance-member", workspaceId, userId: "finance-user", role: "CONTRIBUTOR", isActive: true });
    state.circles.set("circle-1", { id: "circle-1", workspaceId, archivedAt: null });
    state.roleAssignments.push({ memberId, circleId: "circle-1", expiresAt: null });

    await postDeliberationEntry(otherActor, {
      workspaceId,
      parentType: "TENSION",
      parentId: "tension-1",
      entryType: "REACTION",
      bodyMd: "@Finance Team should weigh in.",
      targetCircleId: "circle-1",
    });

    expect(state.notifications).toEqual([
      expect.objectContaining({ userId: "member-user", type: "deliberation.mention" }),
    ]);
  });

  it("does not expose private parent title or body in mention notifications", async () => {
    state.tensions.set("private-tension", {
      id: "private-tension",
      workspaceId,
      authorUserId: "other-user",
      assigneeMemberId: null,
      title: "Private launch risk",
      version: 1,
      isPrivate: true,
    });

    await postDeliberationEntry(otherActor, {
      workspaceId,
      parentType: "TENSION",
      parentId: "private-tension",
      entryType: "REACTION",
      bodyMd: "@Member this draft is confidential.",
    });

    expect(state.notifications).toEqual([
      expect.objectContaining({
        userId: "member-user",
        title: "Other mentioned you in a tension",
        bodyMd: null,
      }),
    ]);
  });

  it("links a deliberation entry to an active advice request", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "I think this is ready.",
      adviceRequestId: "request-1",
    });

    expect(entry.adviceRequestId).toBe("request-1");
    expect(state.events).toContainEqual(expect.objectContaining({
      type: "advice.reply_posted",
      aggregateType: "DeliberationEntry",
      aggregateId: entry.id,
      payload: expect.objectContaining({
        adviceRequestId: "request-1",
        entryId: entry.id,
        parentType: "PROPOSAL",
        parentId: proposalId,
        authorUserId: "member-user",
      }),
    }));
  });

  it("requires bodyMd for OBJECTION", async () => {
    await expect(postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "OBJECTION",
      bodyMd: "",
    })).rejects.toThrow(/Deliberation entries require a non-empty bodyMd/);
  });

  it("allows multiple reaction entries", async () => {
    const entry1 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "First reaction",
    });
    const entry2 = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Second reaction",
    });

    expect(entry1.id).not.toBe(entry2.id);
    await expect(listDeliberationEntries(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    })).resolves.toHaveLength(2);
  });

  it("lists deliberation entries for multiple parents in one grouped read", async () => {
    state.proposals.set("proposal-2", { id: "proposal-2", workspaceId, authorUserId: "admin-user", version: 1 });
    const firstEntry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "First proposal reaction",
    });
    const secondEntry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: "proposal-2",
      entryType: "OBJECTION",
      bodyMd: "Second proposal objection",
    });
    const laterFirstEntry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Later first proposal reaction",
    });

    const entriesByParent = await listDeliberationEntriesForParents(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentIds: [proposalId, "proposal-2", "missing-parent"],
    });

    expect(entriesByParent.get(proposalId)?.map((entry) => entry.id)).toEqual([firstEntry.id, laterFirstEntry.id]);
    expect(entriesByParent.get("proposal-2")?.map((entry) => entry.id)).toEqual([secondEntry.id]);
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
      targetMemberId: memberId,
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
      bodyMd: "I am concerned.",
    });

    const resolved = await resolveDeliberationEntry(adminActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Fixed it",
    });

    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedNote).toBe("Fixed it");
  });

  it("allows the targeted member to edit an unresolved entry and audits the previous body", async () => {
    const entry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Please review.",
      targetMemberId: memberId,
    });

    const updated = await updateDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      entryType: "OBJECTION",
      bodyMd: "This needs a tighter rollout plan.",
    });

    expect(updated.entryType).toBe("OBJECTION");
    expect(updated.bodyMd).toBe("This needs a tighter rollout plan.");

    const audit = state.auditLogs.find((log) => log.action === "deliberation.entry_updated" && log.entityId === entry.id);
    expect(audit?.meta).toMatchObject({
      parentType: "PROPOSAL",
      parentId: proposalId,
      changedFields: ["entryType", "bodyMd"],
      previousState: {
        entryType: "REACTION",
        bodyMd: "Please review.",
      },
    });
  });

  it("allows the assigned parent action member to edit an unresolved action entry", async () => {
    const entry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "ACTION",
      parentId: actionId,
      entryType: "REACTION",
      bodyMd: "Initial action context.",
    });

    const updated = await updateDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      bodyMd: "Owner updated action context.",
    });

    expect(updated.bodyMd).toBe("Owner updated action context.");
  });

  it("prevents unrelated members from editing unresolved entries", async () => {
    const entry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Needs a change.",
    });

    await expect(updateDeliberationEntry(otherActor, {
      workspaceId,
      entryId: entry.id,
      bodyMd: "Not allowed.",
    })).rejects.toThrow(/Only the entry author, target, parent owner, assigned member, or a workspace admin can edit/);
  });

  it("prevents editing resolved entries", async () => {
    const entry = await postDeliberationEntry(memberActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Needs a change.",
    });
    await resolveDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Handled.",
    });

    await expect(updateDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      bodyMd: "Edit after resolve.",
    })).rejects.toThrow(/Resolved deliberation entries cannot be edited/);
  });

  it("prevents resolving by non-admin non-author", async () => {
    const entry = await postDeliberationEntry(adminActor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
      entryType: "REACTION",
      bodyMd: "Needs a change.",
    });

    await expect(resolveDeliberationEntry(memberActor, {
      workspaceId,
      entryId: entry.id,
      resolvedNote: "Not allowed",
    })).rejects.toThrow(/Only the entry author, target, parent owner, assigned member, or a workspace admin can resolve/);
  });
});
