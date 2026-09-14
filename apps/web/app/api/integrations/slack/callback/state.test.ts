import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), cookie: vi.fn(), exchange: vi.fn(), save: vi.fn(), target: vi.fn(), capability: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requirePageActor: mocks.actor }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie, delete: vi.fn() }) }));
vi.mock("@corgtex/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@corgtex/domain")>()),
  exchangeSlackOAuthCode: mocks.exchange,
  saveSlackInstallation: mocks.save,
  getSlackOAuthInstallTarget: mocks.target,
  supportCapabilityVersion: mocks.capability,
}));

import { createSlackOAuthState } from "@corgtex/domain";
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ kind: "user", user: { id: "support-1", globalRole: "USER" } });
  mocks.target.mockResolvedValue({ workspaceId: "ws-1", expectedTeamId: "T1" });
  mocks.capability.mockResolvedValue(3);
  mocks.exchange.mockResolvedValue({ ok: true, team: { id: "T1" }, access_token: "local-fixture" });
  mocks.save.mockResolvedValue({ id: "local-fixture" });
});

describe("Slack callback authenticated state", () => {
  it.each([
    { supportGrantVersion: 3 }, { workspaceId: "ws-2" }, { initiatedByUserId: "owner-1" },
    { preparedSelectedChannels: false }, { flow: "control_plane", deploymentId: "dep-1" },
  ])("rejects a payload and matching cookie changed together: %j", async (changes) => {
    const original = createSlackOAuthState("ws-1", { expectedTeamId: "T1",
      flow: { kind: "workspace", initiatedByUserId: "support-1", supportGrantVersion: 1, preparedSelectedChannels: true } });
    const [payload, signature] = original.value.split(".");
    const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), ...changes })).toString("base64url");
    const state = `${modified}.${signature}`;
    mocks.cookie.mockReturnValue({ value: `${state}:${original.nonce}` });
    const response = await GET(new Request(`http://localhost:3183/api/integrations/slack/callback?code=fixture&state=${encodeURIComponent(state)}`));
    expect(response.headers.get("location")).toContain("slack-invalid-state");
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.capability).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts intact signed state and checks its captured workspace/user/version", async () => {
    const state = createSlackOAuthState("ws-1", { expectedTeamId: "T1",
      flow: { kind: "workspace", initiatedByUserId: "support-1", supportGrantVersion: 3, preparedSelectedChannels: true } });
    mocks.cookie.mockReturnValue({ value: `${state.value}:${state.nonce}` });
    const response = await GET(new Request(`http://localhost:3183/api/integrations/slack/callback?code=fixture&state=${encodeURIComponent(state.value)}`));
    expect(response.headers.get("location")).toContain("slack=connected");
    expect(mocks.capability).toHaveBeenCalledWith("support-1", "ws-1", 3);
    expect(mocks.exchange).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws-1", preparedSelectedChannels: true }));
  });
});
