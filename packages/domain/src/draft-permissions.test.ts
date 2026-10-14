import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
const {authorize} = vi.hoisted(() => ({authorize: vi.fn()}));
vi.mock("./auth", () => ({requireWorkspaceMembership: authorize}));
import {canEditPrivateDraft, requirePrivateDraftEditor} from "./collaborative-permissions";
import { canManageDraftRecord, requireDraftManager } from "./draft-permissions";
const actor: AppActor = {kind: "user", user: {id: "owner", email: "owner@example.test", displayName: "Owner"}};
const membership: MembershipSummary = {id: "member-owner", workspaceId: "ws-1", userId: "owner", role: "CONTRIBUTOR", isActive: true};
const record = {workspaceId: "ws-1", authorUserId: "owner", ownerMemberId: "member-owner"};
beforeEach(() => {vi.resetAllMocks(); authorize.mockResolvedValue(membership);});
describe("current human draft authority", () => {
  it.each(["credential", "bootstrap", "control-plane"])("denies %s despite scopes, admin-shaped membership or human attribution", provider => {
    const agent = {kind: "agent", authProvider: provider, credentialId: "credential", workspaceIds: ["ws-1"], scopes: ["support:write", "brain:write"],
      supportOrigin: {userId: "owner", workspaceId: "ws-1", version: 1}} as AppActor;
    expect(canManageDraftRecord(agent, {...membership, role: "ADMIN"}, record)).toBe(false);
    expect(canEditPrivateDraft(agent, {...membership, role: "ADMIN"}, record)).toBe(false);
    expect(() => requirePrivateDraftEditor(agent, {...membership, role: "ADMIN"}, record)).toThrow("Only the draft creator");
  });
  it("allows only the active matching human owner/requester/member or workspace administrator", () => {
    expect(canManageDraftRecord(actor, membership, record)).toBe(true);
    expect(canManageDraftRecord(actor, membership, {workspaceId: "ws-1", requesterUserId: "owner"})).toBe(true);
    expect(canManageDraftRecord(actor, membership, {workspaceId: "ws-1", ownerMemberId: membership.id})).toBe(true);
    expect(canManageDraftRecord(actor, {...membership, role: "ADMIN"}, {workspaceId: "ws-1", authorUserId: "other"})).toBe(true);
    for (const member of [null, {...membership, isActive: false}, {...membership, workspaceId: "ws-other"}, {...membership, userId: "other"}]) {
      expect(canManageDraftRecord(actor, member, record)).toBe(false);
    }
    expect(canManageDraftRecord(actor, membership, {workspaceId: "ws-1", authorUserId: "other"})).toBe(false);
  });
  it("rechecks current membership in the supplied transaction rather than trusting cached admin access", async () => {
    const tx = {} as any;
    authorize.mockResolvedValue({...membership, role: "CONTRIBUTOR"});
    await expect(requireDraftManager({actor, workspaceId: "ws-1", record: {workspaceId: "ws-1", authorUserId: "other"},
      resolvedMembership: {...membership, role: "ADMIN"}, tx})).rejects.toMatchObject({code: "FORBIDDEN"});
    expect(authorize).toHaveBeenCalledExactlyOnceWith({actor, workspaceId: "ws-1", tx});
  });
  it("does not grant authority to foreign or archived record identities", async () => {
    await expect(requireDraftManager({actor, workspaceId: "ws-1", record: {...record, workspaceId: "ws-other"}})).rejects.toMatchObject({code: "NOT_FOUND"});
    await expect(requireDraftManager({actor, workspaceId: "ws-1", record: {...record, archivedAt: new Date()}})).rejects.toMatchObject({code: "INVALID_STATE"});
    expect(authorize).not.toHaveBeenCalled();
  });
});
