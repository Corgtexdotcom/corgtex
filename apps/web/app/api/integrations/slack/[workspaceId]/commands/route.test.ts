import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySlackRequest, verifySlackWorkspaceInstallation, handleSlackCommand, handleRouteError } = vi.hoisted(() => ({
  verifySlackRequest: vi.fn(), verifySlackWorkspaceInstallation: vi.fn(), handleSlackCommand: vi.fn(), handleRouteError: vi.fn(),
}));
vi.mock("@corgtex/domain", () => ({ verifySlackRequest, verifySlackWorkspaceInstallation, handleSlackCommand }));
vi.mock("@/lib/http", () => ({ handleRouteError }));
import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const rawBody = "team_id=TEXPECTED&api_app_id=AEXPECTED&command=%2Fcorgtex&workspaceId=body-untrusted";
const context = () => ({ params: Promise.resolve({ workspaceId }) });
const request = (body = rawBody) => new NextRequest(`https://app.example.test/api/integrations/slack/${workspaceId}/commands?workspaceId=query-untrusted`, {
  method: "POST", body, headers: { "x-slack-signature": "synthetic-signature" },
});

beforeEach(() => {
  vi.resetAllMocks();
  handleSlackCommand.mockResolvedValue({ ok: true });
  verifySlackWorkspaceInstallation.mockResolvedValue(undefined);
  handleRouteError.mockImplementation((error) => NextResponse.json({ code: error.code ?? "INVALID_REQUEST" }, { status: error.status ?? 400 }));
});

describe("workspace-scoped Slack commands route", () => {
  it("verifies unchanged signed bytes and trusted path, then persisted scope before handling", async () => {
    const req = request();
    const response = await POST(req, context());
    expect(response.status).toBe(200);
    expect(verifySlackRequest).toHaveBeenCalledExactlyOnceWith(rawBody, req.headers, workspaceId);
    expect(verifySlackWorkspaceInstallation).toHaveBeenCalledExactlyOnceWith(workspaceId, expect.objectContaining({ api_app_id: "AEXPECTED" }));
    expect(handleSlackCommand).toHaveBeenCalledTimes(1);
    expect(verifySlackRequest.mock.invocationCallOrder[0]).toBeLessThan(verifySlackWorkspaceInstallation.mock.invocationCallOrder[0]);
    expect(verifySlackWorkspaceInstallation.mock.invocationCallOrder[0]).toBeLessThan(handleSlackCommand.mock.invocationCallOrder[0]);
  });

  it.each([401, 403, 503])("does not look up installation or handle rejected signature/scope/config (%i)", async (status) => {
    const error = { status, code: "SAFE_SLACK_FAILURE" };
    verifySlackRequest.mockImplementationOnce(() => { throw error; });
    const response = await POST(request(), context());
    expect(response.status).toBe(status);
    expect(verifySlackWorkspaceInstallation).not.toHaveBeenCalled();
    expect(handleSlackCommand).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("rejects signed but mismatched persisted installation without handler effects", async () => {
    verifySlackWorkspaceInstallation.mockRejectedValueOnce({ status: 403, code: "SLACK_TEAM_MISMATCH" });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(handleSlackCommand).not.toHaveBeenCalled();
  });

});
