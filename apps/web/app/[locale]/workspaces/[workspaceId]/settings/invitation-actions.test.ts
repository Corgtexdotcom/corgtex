import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePageActor: vi.fn(),
  enforceDemoGuard: vi.fn(),
  createMember: vi.fn(),
  inviteMember: vi.fn(),
  bulkInviteMembers: vi.fn(),
  updateMember: vi.fn(),
  approveMemberInviteRequest: vi.fn(),
  resendMemberAccessLink: vi.fn(),
  sendEmail: vi.fn(),
  findWorkspace: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.requirePageActor }));
vi.mock("@/lib/demo-guard", () => ({ enforceDemoGuard: mocks.enforceDemoGuard }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@corgtex/domain", () => ({
  ...mocks,
  renderAccountSetupEmail: () => "synthetic email body",
}));
vi.mock("@corgtex/shared", () => ({
  sendEmail: mocks.sendEmail,
  prisma: { workspace: { findUnique: mocks.findWorkspace } },
}));

const actor = { kind: "user", user: { id: "owner-1" } };
const user = { id: "recipient-1", email: "recipient@example.test", displayName: null };

function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspaceId: "workspace-1", email: user.email, role: "CONTRIBUTOR",
    memberId: "member-1", requestId: "request-1", csvData: `,${user.email},CONTRIBUTOR`,
  })) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RESEND_API_KEY", "synthetic-key");
  mocks.requirePageActor.mockResolvedValue(actor);
  mocks.findWorkspace.mockResolvedValue({ name: "Synthetic workspace" });
  mocks.sendEmail.mockResolvedValue({ status: "SENT", providerMessageId: "provider-1" });
  for (const mutation of [mocks.createMember, mocks.inviteMember, mocks.updateMember,
    mocks.approveMemberInviteRequest, mocks.resendMemberAccessLink]) {
    mutation.mockResolvedValue({ user, token: "synthetic-token", setupToken: "synthetic-token" });
  }
  mocks.bulkInviteMembers.mockResolvedValue({ invited: 1, details: [{
    email: user.email, displayName: null, token: "synthetic-token",
  }] });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("invitation email outcomes", () => {
  it.each([
    "createMemberAction", "inviteMemberAction", "bulkInviteAction", "updateMemberAction",
    "approveMemberInviteRequestAction", "resendMemberAccessLinkAction",
  ] as const)("%s preserves the saved mutation but reports a skipped email", async (actionName) => {
    const actions = await import("./actions");
    vi.stubEnv("RESEND_API_KEY", " ");
    mocks.sendEmail.mockResolvedValue({ status: "SKIPPED", reason: "RESEND_API_KEY missing" });
    const result = await actions[actionName](form());
    expect(result.success).toBe(true);
    expect(result.emailStatus).toEqual({ sent: false, error: "RESEND_API_KEY missing" });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("records provider acceptance with workspace tracking and no credential metadata", async () => {
    const { createMemberAction } = await import("./actions");
    const result = await createMemberAction(form());
    expect(result).toEqual({ success: true, emailStatus: { sent: true } });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: user.email,
      tracking: { emailType: "admin-added", workspaceId: "workspace-1" },
    }));
    expect(mocks.createMember).toHaveBeenCalledTimes(1);
  });

  it("does not retry a committed member or failed provider send", async () => {
    const { createMemberAction } = await import("./actions");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.sendEmail.mockRejectedValue(new Error("Provider unavailable"));
      expect(await createMemberAction(form())).toEqual({
        success: true, emailStatus: { sent: false, error: "Provider unavailable" },
      });
      expect(mocks.createMember).toHaveBeenCalledTimes(1);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it("does not send mail when authorization rejects the mutation", async () => {
    const { createMemberAction } = await import("./actions");
    mocks.requirePageActor.mockRejectedValue(new Error("Not authorized"));
    expect(await createMemberAction(form())).toEqual({ success: false, error: "Not authorized" });
    expect(mocks.createMember).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
