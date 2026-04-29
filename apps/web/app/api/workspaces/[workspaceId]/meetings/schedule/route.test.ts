import { afterEach, describe, expect, it, vi } from "vitest";

const { createMeetingSeries, enqueueMeetingAgendaPreparation, resolveRequestActor, handleRouteError } = vi.hoisted(() => ({
  createMeetingSeries: vi.fn(),
  enqueueMeetingAgendaPreparation: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  createMeetingSeries,
  enqueueMeetingAgendaPreparation,
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

describe("POST /api/workspaces/[workspaceId]/meetings/schedule", () => {
  it("creates an internal meeting series and queues agenda preparation", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createMeetingSeries.mockResolvedValue({ series: { id: "series-1" }, meetings: [] });
    enqueueMeetingAgendaPreparation.mockResolvedValue({ id: "job-1" });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Weekly Tactical",
          startsAt: "2026-04-30T17:00:00.000Z",
          scheduledEndAt: "2026-04-30T18:00:00.000Z",
          recurrenceRule: "FREQ=WEEKLY",
          participantEmails: ["jan@example.com"],
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(createMeetingSeries).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Weekly Tactical",
        recurrenceRule: "FREQ=WEEKLY",
        participantEmails: ["jan@example.com"],
      }),
    );
    expect(enqueueMeetingAgendaPreparation).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1" },
    );
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
