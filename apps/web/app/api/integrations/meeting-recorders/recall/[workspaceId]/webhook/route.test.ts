import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { processMeetingRecorderWebhook, handleRouteError } = vi.hoisted(() => ({
  processMeetingRecorderWebhook: vi.fn(),
  handleRouteError: vi.fn(),
}));
vi.mock("@corgtex/domain", () => ({ processMeetingRecorderWebhook }));
vi.mock("@/lib/http", () => ({ handleRouteError }));

import { POST } from "./route";

describe("workspace-scoped Recall webhook route", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => vi.resetAllMocks());

  it("forwards the trusted path scope and original signed bytes, not body or query scope", async () => {
    const rawBody = '{ "data": { "workspaceId": "untrusted-body" } }';
    const request = new NextRequest(`https://app.example.com/api/integrations/meeting-recorders/recall/${workspaceId}/webhook?workspaceId=untrusted-query`, {
      method: "POST", body: rawBody, headers: { "svix-signature": "synthetic-signature" },
    });
    processMeetingRecorderWebhook.mockResolvedValue({ processed: true, duplicate: false });
    const response = await POST(request, { params: Promise.resolve({ workspaceId }) });
    expect(processMeetingRecorderWebhook).toHaveBeenCalledExactlyOnceWith("RECALL_AI", {
      workspaceId, headers: request.headers, rawBody,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ processed: true, duplicate: false });
  });

  it.each([401, 403, 503])("preserves domain failure status %i instead of acknowledging delivery", async (status) => {
    const error = { status, code: "SAFE_RECORDER_FAILURE" };
    processMeetingRecorderWebhook.mockRejectedValue(error);
    handleRouteError.mockReturnValue(NextResponse.json({ code: error.code }, { status }));
    const response = await POST(new NextRequest("https://app.example.com/webhook", { method: "POST", body: "{}" }), {
      params: Promise.resolve({ workspaceId }),
    });
    expect(handleRouteError).toHaveBeenCalledExactlyOnceWith(error);
    expect(response.status).toBe(status);
  });
});
