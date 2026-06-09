import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  listGoogleDriveDocuments,
  selectGoogleDriveDocumentsForSync,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  listGoogleDriveDocuments: vi.fn(),
  selectGoogleDriveDocumentsForSync: vi.fn(),
  resolveRequestActor: vi.fn(),
  checkApiDemoGuard: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  listGoogleDriveDocuments,
  selectGoogleDriveDocumentsForSync,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/onboarding/google-drive", () => {
  it("lists Google Drive documents for the current workspace actor", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    listGoogleDriveDocuments.mockResolvedValue({
      connection: { id: "conn-1", hasDocumentScope: true },
      documents: [{ id: "doc-1", name: "Launch notes" }],
    });
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/google-drive?q=Launch"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(listGoogleDriveDocuments).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", query: "Launch" },
    );
    await expect(response.json()).resolves.toEqual({
      connection: { id: "conn-1", hasDocumentScope: true },
      documents: [{ id: "doc-1", name: "Launch notes" }],
    });
  });

  it("selects Drive documents through the demo guard before queueing sync", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    selectGoogleDriveDocumentsForSync.mockResolvedValue({ scheduled: ["oauth.documents.sync"] });
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/google-drive", {
        method: "POST",
        body: JSON.stringify({ documentIds: ["doc-1"] }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(selectGoogleDriveDocumentsForSync).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", documentIds: ["doc-1"] },
    );
    await expect(response.json()).resolves.toEqual({ scheduled: ["oauth.documents.sync"] });
  });
});

