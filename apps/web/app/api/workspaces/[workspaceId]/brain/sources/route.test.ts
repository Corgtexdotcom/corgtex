import { afterEach, describe, expect, it, vi } from "vitest";

const {
  handleRouteError,
  ingestSource,
  listSources,
  resolveRequestActor,
} = vi.hoisted(() => ({
  handleRouteError: vi.fn(),
  ingestSource: vi.fn(),
  listSources: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  ingestSource,
  listSources,
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

function postBrainSource(body: unknown) {
  return new Request("http://localhost/api/workspaces/ws-1/brain/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/workspaces/[workspaceId]/brain/sources", () => {
  it("lets domain attribution default omitted API authors to the current member", async () => {
    const actor = { kind: "user" as const, user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    ingestSource.mockResolvedValue({ id: "source-1" });

    const { POST } = await import("./route");
    const response = await POST(
      postBrainSource({
        sourceType: "DOC",
        content: "Policy text",
        title: "Policy",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(ingestSource).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      content: "Policy text",
    }));
    expect(ingestSource.mock.calls[0]?.[1]).not.toHaveProperty("authorMemberId");
    expect(handleRouteError).not.toHaveBeenCalled();
  });

  it("passes explicit API author attribution through", async () => {
    const actor = { kind: "agent" as const, authProvider: "credential", workspaceIds: ["ws-1"], scopes: ["brain:write"] };
    resolveRequestActor.mockResolvedValue(actor);
    ingestSource.mockResolvedValue({ id: "source-1" });

    const { POST } = await import("./route");
    await POST(
      postBrainSource({
        sourceType: "DOC",
        content: "Policy text",
        authorMemberId: "member-1",
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(ingestSource).toHaveBeenCalledWith(actor, expect.objectContaining({
      authorMemberId: "member-1",
    }));
  });
});
