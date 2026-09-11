import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySlackRequest, verifySlackWorkspaceInstallation, handleSlackInteraction, handleRouteError } = vi.hoisted(() => ({
  verifySlackRequest: vi.fn(), verifySlackWorkspaceInstallation: vi.fn(), handleSlackInteraction: vi.fn(), handleRouteError: vi.fn(),
}));
vi.mock("@corgtex/domain", () => ({ verifySlackRequest, verifySlackWorkspaceInstallation, handleSlackInteraction }));
vi.mock("@/lib/http", () => ({ handleRouteError }));
import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const rawBody = "payload=%7B%22team%22%3A%7B%22id%22%3A%22TEXPECTED%22%7D%2C%22api_app_id%22%3A%22AEXPECTED%22%2C%22type%22%3A%22block_actions%22%2C%22workspaceId%22%3A%22body-untrusted%22%7D";
const context = () => ({ params: Promise.resolve({ workspaceId }) });
const request = (body = rawBody) => new NextRequest(`https://app.example.test/api/integrations/slack/${workspaceId}/interactivity?workspaceId=query-untrusted`, {
  method: "POST", body, headers: { "x-slack-signature": "synthetic-signature" },
});

beforeEach(() => {
  vi.resetAllMocks();
  handleSlackInteraction.mockResolvedValue({ ok: true });
  verifySlackWorkspaceInstallation.mockResolvedValue(undefined);
  handleRouteError.mockImplementation((error) => NextResponse.json({ code: error.code ?? "INVALID_REQUEST" }, { status: error.status ?? 400 }));
});

describe("workspace-scoped Slack interactivity route", () => {
  it("verifies unchanged signed bytes and trusted path, then persisted scope before handling", async () => {
    const req = request();
    const response = await POST(req, context());
    expect(response.status).toBe(200);
    expect(verifySlackRequest).toHaveBeenCalledExactlyOnceWith(rawBody, req.headers, workspaceId);
    expect(verifySlackWorkspaceInstallation).toHaveBeenCalledExactlyOnceWith(workspaceId, expect.objectContaining({ api_app_id: "AEXPECTED" }));
    expect(handleSlackInteraction).toHaveBeenCalledTimes(1);
    expect(verifySlackRequest.mock.invocationCallOrder[0]).toBeLessThan(verifySlackWorkspaceInstallation.mock.invocationCallOrder[0]);
    expect(verifySlackWorkspaceInstallation.mock.invocationCallOrder[0]).toBeLessThan(handleSlackInteraction.mock.invocationCallOrder[0]);
  });

  it.each([401, 403, 503])("does not look up installation or handle rejected signature/scope/config (%i)", async (status) => {
    const error = { status, code: "SAFE_SLACK_FAILURE" };
    verifySlackRequest.mockImplementationOnce(() => { throw error; });
    const response = await POST(request(), context());
    expect(response.status).toBe(status);
    expect(verifySlackWorkspaceInstallation).not.toHaveBeenCalled();
    expect(handleSlackInteraction).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("rejects signed but mismatched persisted installation without handler effects", async () => {
    verifySlackWorkspaceInstallation.mockRejectedValueOnce({ status: 403, code: "SLACK_TEAM_MISMATCH" });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(handleSlackInteraction).not.toHaveBeenCalled();
  });
  it("does not invoke installation or handler for missing interaction payload", async () => {
    const response = await POST(request("team_id=TEXPECTED"), context());
    expect(response.status).toBe(400);
    expect(verifySlackWorkspaceInstallation).not.toHaveBeenCalled();
    expect(handleSlackInteraction).not.toHaveBeenCalled();
  });
});
