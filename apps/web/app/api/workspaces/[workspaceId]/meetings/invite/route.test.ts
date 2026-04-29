import { afterEach, describe, expect, it, vi } from "vitest";

const { importMeetingInvite, enqueueMeetingAgendaPreparation, resolveRequestActor, handleRouteError } = vi.hoisted(() => ({
  importMeetingInvite: vi.fn(),
  enqueueMeetingAgendaPreparation: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  importMeetingInvite,
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

describe("POST /api/workspaces/[workspaceId]/meetings/invite", () => {
  it("accepts multipart .ics uploads and queues agenda preparation", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    importMeetingInvite.mockResolvedValue([{ seriesId: "series-1", meetings: [] }]);
    enqueueMeetingAgendaPreparation.mockResolvedValue({ id: "job-1" });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("invite", new File(["BEGIN:VCALENDAR\nEND:VCALENDAR"], "invite.ics", { type: "text/calendar" }));

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/invite", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(importMeetingInvite).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", icsText: "BEGIN:VCALENDAR\nEND:VCALENDAR" },
    );
    expect(enqueueMeetingAgendaPreparation).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1" },
    );
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
