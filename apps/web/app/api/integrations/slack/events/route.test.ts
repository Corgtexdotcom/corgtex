import { describe, expect, it, vi } from "vitest";

const { verifySlackRequestMock, ingestCommunicationEventMock } = vi.hoisted(() => ({
  verifySlackRequestMock: vi.fn(),
  ingestCommunicationEventMock: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  verifySlackRequest: verifySlackRequestMock,
  ingestCommunicationEvent: ingestCommunicationEventMock,
  AppError: class AppError extends Error {
    status = 400;
    code = "TEST_ERROR";
  },
}));

describe("POST /api/integrations/slack/events", () => {
  it("responds to Slack URL verification", async () => {
    const { POST } = await import("./route");
    const request = new Request("https://app.example.test/api/integrations/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "challenge-token" }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("challenge-token");
    expect(verifySlackRequestMock).toHaveBeenCalled();
    expect(ingestCommunicationEventMock).not.toHaveBeenCalled();
  });

  it("enqueues Slack event callbacks", async () => {
    const { POST } = await import("./route");
    const body = { type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "message" } };
    const request = new Request("https://app.example.test/api/integrations/slack/events", {
      method: "POST",
      body: JSON.stringify(body),
    });
    ingestCommunicationEventMock.mockResolvedValueOnce({ inboundEventId: "inbound-1" });

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(ingestCommunicationEventMock).toHaveBeenCalledWith("SLACK", body);
  });
});
