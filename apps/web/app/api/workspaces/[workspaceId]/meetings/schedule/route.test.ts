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
        startsAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
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

  it("converts timezone-local meeting series times before creating meetings", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createMeetingSeries.mockResolvedValue({ series: { id: "series-1" }, meetings: [] });
    enqueueMeetingAgendaPreparation.mockResolvedValue({ id: "job-1" });

    const { POST } = await import("./route");
    await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Weekly Tactical",
          startsAt: "2026-06-11T14:07",
          scheduledEndAt: "2026-06-11T15:07",
          timeZone: "America/Los_Angeles",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(createMeetingSeries).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        startsAt: new Date("2026-06-11T21:07:00.000Z"),
        scheduledEndAt: new Date("2026-06-11T22:07:00.000Z"),
      }),
    );
  });

  it("prefers durationMinutes over scheduledEndAt when both are present", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createMeetingSeries.mockResolvedValue({ series: { id: "series-1" }, meetings: [] });
    enqueueMeetingAgendaPreparation.mockResolvedValue({ id: "job-1" });

    const { POST } = await import("./route");
    await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Weekly Tactical",
          startsAt: "2026-04-30T17:00:00.000Z",
          durationMinutes: 45,
          scheduledEndAt: "2026-04-30T20:00:00.000Z",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(createMeetingSeries).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        startsAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T17:45:00.000Z"),
      }),
    );
  });

  it("defaults durationMinutes to one hour when no end input is present", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createMeetingSeries.mockResolvedValue({ series: { id: "series-1" }, meetings: [] });
    enqueueMeetingAgendaPreparation.mockResolvedValue({ id: "job-1" });

    const { POST } = await import("./route");
    await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Weekly Tactical",
          startsAt: "2026-04-30T17:00:00.000Z",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(createMeetingSeries).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
      }),
    );
  });
});
