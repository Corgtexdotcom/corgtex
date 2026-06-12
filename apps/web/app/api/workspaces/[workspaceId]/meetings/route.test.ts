import { afterEach, describe, expect, it, vi } from "vitest";

const { createMeeting, listMeetings, requireWorkspaceMembership, resolveRequestActor, handleRouteError } = vi.hoisted(() => ({
  createMeeting: vi.fn(),
  listMeetings: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  createMeeting,
  listMeetings,
  requireWorkspaceMembership,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/[workspaceId]/meetings", () => {
  it("converts timezone-local recordedAt before creating a meeting", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createMeeting.mockResolvedValue({ id: "meeting-1" });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Customer Call",
          source: "manual",
          recordedAt: "2026-06-11T14:07",
          timeZone: "America/Los_Angeles",
          transcript: "Transcript body",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(createMeeting).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Customer Call",
        source: "manual",
        recordedAt: new Date("2026-06-11T21:07:00.000Z"),
        transcript: "Transcript body",
      }),
    );
  });
});
