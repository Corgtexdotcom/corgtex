import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  runMemberCleanup,
} from "./member-cleanup-runner.ts";

const actor = {
  kind: "user",
  user: {
    id: "user-admin",
    email: "admin@example.com",
    displayName: "Admin",
    globalRole: "OPERATOR",
  },
};

function member(id, email, overrides = {}) {
  return {
    id,
    workspaceId: "workspace-1",
    userId: `user-${id}`,
    role: "CONTRIBUTOR",
    kind: "HUMAN",
    isActive: true,
    mergedIntoMemberId: null,
    user: {
      id: `user-${id}`,
      email,
      displayName: id,
      globalRole: "USER",
    },
    emailAliases: [],
    ...overrides,
  };
}

function adaptersFixture(membersByRef) {
  return {
    resolveWorkspace: vi.fn().mockResolvedValue({
      id: "workspace-1",
      slug: "workspace",
      name: "Workspace",
    }),
    resolveActor: vi.fn().mockResolvedValue(actor),
    ensureAdminAccess: vi.fn().mockResolvedValue(undefined),
    resolveMember: vi.fn(async (_workspaceId, ref) => membersByRef[ref] ?? null),
    mergeMembers: vi.fn().mockResolvedValue({
      sourceMemberId: "member-source",
      targetMemberId: "member-target",
      aliasEmails: ["source@example.com"],
      rewired: { "goal.ownerMemberId": 1 },
    }),
  };
}

describe("member cleanup runner", () => {
  it("parses a dry-run merge request with aliases", () => {
    expect(parseArgs([
      "--workspace", "workspace-alpha",
      "--actor-email=Admin@Example.COM",
      "--pair", "source@example.com=target@example.com",
      "--alias", "source@example.com=source.old@example.com",
      "--reason", "Duplicate cleanup",
    ])).toEqual({
      apply: false,
      workspaceRef: "workspace-alpha",
      actorEmail: "admin@example.com",
      pairs: [{ sourceRef: "source@example.com", targetRef: "target@example.com" }],
      aliases: [{ sourceRef: "source@example.com", email: "source.old@example.com" }],
      reason: "Duplicate cleanup",
    });
  });

  it("plans merges without writing by default", async () => {
    const source = member("member-source", "source@example.com", {
      emailAliases: [{ email: "source.alias@example.com", source: "MANUAL" }],
    });
    const target = member("member-target", "target@example.com");
    const adapters = adaptersFixture({
      "source@example.com": source,
      "target@example.com": target,
    });

    const result = await runMemberCleanup(parseArgs([
      "--workspace", "workspace",
      "--actor-email", "admin@example.com",
      "--pair", "source@example.com=target@example.com",
      "--alias", "source@example.com=Source.Legacy@Example.com",
    ]), adapters);

    expect(adapters.ensureAdminAccess).toHaveBeenCalledWith(actor, "workspace-1");
    expect(adapters.mergeMembers).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      planned: 1,
      merged: 0,
      merges: [
        {
          status: "planned",
          aliasEmails: [
            "source.alias@example.com",
            "source.legacy@example.com",
            "source@example.com",
          ],
        },
      ],
    });
  });

  it("delegates applied cleanup to the domain merge primitive", async () => {
    const source = member("member-source", "source@example.com");
    const target = member("member-target", "target@example.com", { role: "ADMIN" });
    const adapters = adaptersFixture({
      "member-source": source,
      "member-target": target,
    });

    const result = await runMemberCleanup(parseArgs([
      "--workspace", "workspace",
      "--actor-email", "admin@example.com",
      "--pair", "member-source=member-target",
      "--alias", "member-source=source.old@example.com",
      "--reason", "Duplicate workspace member",
      "--apply",
    ]), adapters);

    expect(adapters.mergeMembers).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      sourceMemberId: "member-source",
      targetMemberId: "member-target",
      aliasEmails: ["source.old@example.com"],
      reason: "Duplicate workspace member",
    });
    expect(result).toMatchObject({
      dryRun: false,
      merged: 1,
      merges: [{ status: "merged", rewired: { "goal.ownerMemberId": 1 } }],
    });
  });

  it("rejects chained source and target merges in one run", async () => {
    const first = member("member-first", "first@example.com");
    const second = member("member-second", "second@example.com");
    const third = member("member-third", "third@example.com");
    const adapters = adaptersFixture({
      first,
      second,
      third,
    });

    await expect(runMemberCleanup(parseArgs([
      "--workspace", "workspace",
      "--actor-email", "admin@example.com",
      "--pair", "first=second",
      "--pair", "second=third",
    ]), adapters)).rejects.toThrow("cannot be both source and target");
    expect(adapters.mergeMembers).not.toHaveBeenCalled();
  });

  it("rejects aliases that do not match a merge source", async () => {
    const source = member("member-source", "source@example.com");
    const target = member("member-target", "target@example.com");
    const adapters = adaptersFixture({
      source,
      target,
    });

    await expect(runMemberCleanup(parseArgs([
      "--workspace", "workspace",
      "--actor-email", "admin@example.com",
      "--pair", "source=target",
      "--alias", "other=other.old@example.com",
    ]), adapters)).rejects.toThrow("does not match any merge source");
    expect(adapters.mergeMembers).not.toHaveBeenCalled();
  });
});
