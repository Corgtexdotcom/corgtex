import { afterEach, describe, expect, it, vi } from "vitest";

const {
  ingestSource,
  intakeMeetingTranscript,
  requireWorkspaceMembership,
  resolveRequestActor,
  handleRouteError,
} = vi.hoisted(() => ({
  ingestSource: vi.fn(),
  intakeMeetingTranscript: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  ingestSource,
  intakeMeetingTranscript,
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

function postTextIngest(body: unknown) {
  return new Request("http://localhost/api/workspaces/ws-1/data-sources/text-ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/workspaces/[workspaceId]/data-sources/text-ingest", () => {
  it("routes MEETING source types through meeting transcript intake", async () => {
    const actor = { kind: "user" as const, user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    intakeMeetingTranscript.mockResolvedValue({
      status: "meeting_created",
      meeting: { id: "meeting-1", title: "Weekly Tactical" },
      inferred: {},
      message: "Transcript saved as meeting.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      postTextIngest({
        title: "Weekly Tactical",
        sourceType: "MEETING",
        content: "Jan: Milan owns onboarding.",
        recordedAt: "2026-04-30T17:10:00.000Z",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.status).toBe("meeting_created");
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      transcript: "Jan: Milan owns onboarding.",
      title: "Weekly Tactical",
      source: "text-paste",
      recordedAt: "2026-04-30T17:10:00.000Z",
    });
    expect(ingestSource).not.toHaveBeenCalled();
    expect(handleRouteError).not.toHaveBeenCalled();
  });

  it("returns meeting intake clarification responses as conflicts", async () => {
    const actor = { kind: "user" as const, user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    intakeMeetingTranscript.mockResolvedValue({
      status: "needs_clarification",
      requiredFields: ["recordedAt"],
      inferred: { title: null, recordedAt: null, participantEmails: [], source: "text-paste" },
      message: "I can save this as a meeting transcript, but I need the meeting date/time first.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      postTextIngest({
        sourceType: "MEETING",
        content: "Jan: Milan owns onboarding.",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.status).toBe("needs_clarification");
    expect(json.requiredFields).toEqual(["recordedAt"]);
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        workspaceId: "ws-1",
        transcript: "Jan: Milan owns onboarding.",
        title: null,
        source: "text-paste",
        recordedAt: null,
      }),
    );
    expect(ingestSource).not.toHaveBeenCalled();
  });

  it("keeps non-meeting text on the brain source ingest path", async () => {
    const actor = { kind: "user" as const, user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    ingestSource.mockResolvedValue({ id: "source-1", sourceType: "DOC" });

    const { POST } = await import("./route");
    const response = await POST(
      postTextIngest({
        title: "Policy",
        sourceType: "DOC",
        channel: "handbook",
        content: "Policy text",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.id).toBe("source-1");
    expect(ingestSource).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      channel: "handbook",
      authorMemberId: "member-1",
    });
    expect(intakeMeetingTranscript).not.toHaveBeenCalled();
  });

  it("rejects missing content", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });

    const { POST } = await import("./route");
    const response = await POST(
      postTextIngest({
        sourceType: "MEETING",
        content: "",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Content is required");
    expect(intakeMeetingTranscript).not.toHaveBeenCalled();
    expect(ingestSource).not.toHaveBeenCalled();
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
