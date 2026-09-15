import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), user: vi.fn(), create: vi.fn(), link: vi.fn(), transaction: vi.fn(), member: vi.fn() }));
vi.mock("@corgtex/shared", () => ({
  isPasswordLoginDisabled: (hash: string) => hash.startsWith("disabled$"),
  prisma: { userSsoIdentity: { findUnique: mocks.identity, upsert: mocks.link }, user: { findUnique: mocks.user, create: mocks.create }, $transaction: mocks.transaction },
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn() }));
vi.mock("./workspace-support-access", () => ({ lockWorkspaceMembership: vi.fn() }));
import { linkOrProvisionSsoUser } from "./sso";
const params = { workspaceId: "workspace", provider: "GOOGLE", providerSubjectId: "subject", email: "persona@example.com" };
describe("disabled SSO accounts", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.identity.mockResolvedValue(null); mocks.user.mockResolvedValue(null); mocks.transaction.mockImplementation(async callback => callback({ workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) }, member: { upsert: mocks.member } })); });
  it("refuses the reserved demo email before identity lookup or writes", async () => {
    await expect(linkOrProvisionSsoUser({ ...params, email: "  DEMO@JNJ-DEMO.CORGTEX.APP " })).rejects.toMatchObject({ code: "RESERVED_IDENTITY" });
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("refuses a linked demo identity even if provider returns a different email", async () => {
    mocks.identity.mockResolvedValue({ userId: "demo", user: { id: "demo", email: "demo@jnj-demo.corgtex.app", passwordHash: "ordinary-hash" } });
    await expect(linkOrProvisionSsoUser(params)).rejects.toMatchObject({ code: "RESERVED_IDENTITY" });
    expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["email", "identity", "email-with-identity"])("rejects disabled %s before linking or membership writes", async source => {
    const disabled = { id: "disabled", passwordHash: "disabled$synthetic-demo-persona" };
    if (source !== "identity") mocks.user.mockResolvedValue(disabled);
    if (source !== "email") mocks.identity.mockResolvedValue({ userId: source === "identity" ? "disabled" : "ordinary", user: source === "identity" ? disabled : { id: "ordinary", passwordHash: "sso$ordinary" } });
    await expect(linkOrProvisionSsoUser(params)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("continues to accept ordinary SSO-only accounts", async () => {
    const user = { id: "ordinary", passwordHash: "sso$ordinary" };
    mocks.identity.mockResolvedValue({ userId: user.id, user });
    await expect(linkOrProvisionSsoUser(params)).resolves.toEqual(user);
    expect(mocks.member).toHaveBeenCalled();
  });
});
