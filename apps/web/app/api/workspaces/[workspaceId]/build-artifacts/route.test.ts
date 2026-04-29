import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listBuildArtifacts = vi.fn();
const upsertBuildArtifact = vi.fn();
const getBuildArtifact = vi.fn();
const updateBuildArtifact = vi.fn();
const addBuildArtifactAsset = vi.fn();
const revokeBuildArtifactPublicAccess = vi.fn();
const disabledWorkspaceFeatureResponse = vi.fn();

const actor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  listBuildArtifacts,
  upsertBuildArtifact,
  getBuildArtifact,
  updateBuildArtifact,
  addBuildArtifactAsset,
  revokeBuildArtifactPublicAccess,
}));

vi.mock("@/lib/route-handler", () => ({
  withWorkspaceRoute: (handler: any) => async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    const params = await context.params;
    return handler(request, {
      actor,
      membership: {
        id: "member-1",
        role: "ADMIN",
      },
      workspaceId: params.workspaceId,
      params,
    });
  },
}));

vi.mock("@/lib/workspace-feature-route", () => ({
  disabledWorkspaceFeatureResponse,
}));

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

describe("build artifact workspace API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBuildArtifacts.mockResolvedValue([{ id: "artifact-1" }]);
    upsertBuildArtifact.mockResolvedValue({ id: "artifact-1" });
    getBuildArtifact.mockResolvedValue({ id: "artifact-1" });
    updateBuildArtifact.mockResolvedValue({ id: "artifact-1", title: "Updated" });
    addBuildArtifactAsset.mockResolvedValue({ asset: { id: "asset-1" }, artifact: { id: "artifact-1" } });
    revokeBuildArtifactPublicAccess.mockResolvedValue({ id: "artifact-1", visibility: "REVOKED" });
    disabledWorkspaceFeatureResponse.mockResolvedValue(null);
  });

  it("lists and creates artifacts for an authenticated workspace", async () => {
    const { GET, POST } = await import("./route");
    const listResponse = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts"),
      context({ workspaceId: "workspace-1" }),
    );

    await expect(listResponse.json()).resolves.toEqual({ items: [{ id: "artifact-1" }] });
    expect(listBuildArtifacts).toHaveBeenCalledWith(actor, { workspaceId: "workspace-1", status: undefined });

    const createResponse = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: "puncar-dev",
          repositoryName: "corgtex",
          pullRequestNumber: 42,
          title: "Tools proof",
          classification: "OPEN_CORE",
          visibility: "PUBLIC_REVIEW",
          noPrivateDataConfirmed: true,
        }),
      }),
      context({ workspaceId: "workspace-1" }),
    );

    expect(createResponse.status).toBe(201);
    expect(upsertBuildArtifact).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Tools proof",
    }));
  });

  it("returns the feature guard response before touching artifact data", async () => {
    disabledWorkspaceFeatureResponse.mockResolvedValueOnce(
      NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 }),
    );

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts"),
      context({ workspaceId: "workspace-1" }),
    );

    expect(response.status).toBe(404);
    expect(listBuildArtifacts).not.toHaveBeenCalled();
  });

  it("gets and updates artifact details", async () => {
    const { GET, PATCH } = await import("./[artifactId]/route");
    const detailResponse = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts/artifact-1"),
      context({ workspaceId: "workspace-1", artifactId: "artifact-1" }),
    );

    await expect(detailResponse.json()).resolves.toEqual({ id: "artifact-1" });
    expect(getBuildArtifact).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
    });

    const patchResponse = await PATCH(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts/artifact-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated" }),
      }),
      context({ workspaceId: "workspace-1", artifactId: "artifact-1" }),
    );

    await expect(patchResponse.json()).resolves.toEqual({ id: "artifact-1", title: "Updated" });
    expect(updateBuildArtifact).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      title: "Updated",
    });
  });

  it("uploads proof assets and revokes public links", async () => {
    const { POST: upload } = await import("./[artifactId]/assets/route");
    const formData = new FormData();
    formData.append("file", new File([Buffer.from("proof")], "proof.png", { type: "image/png" }));
    formData.append("label", "List view");
    formData.append("captionMd", "Shows the list view.");

    const uploadResponse = await upload(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts/artifact-1/assets", {
        method: "POST",
        body: formData,
      }),
      context({ workspaceId: "workspace-1", artifactId: "artifact-1" }),
    );

    expect(uploadResponse.status).toBe(201);
    expect(addBuildArtifactAsset).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      fileName: "proof.png",
      mimeType: "image/png",
      label: "List view",
      captionMd: "Shows the list view.",
    }));

    const { POST: revoke } = await import("./[artifactId]/revoke-public/route");
    const revokeResponse = await revoke(
      new NextRequest("http://localhost/api/workspaces/workspace-1/build-artifacts/artifact-1/revoke-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Merged" }),
      }),
      context({ workspaceId: "workspace-1", artifactId: "artifact-1" }),
    );

    await expect(revokeResponse.json()).resolves.toEqual({ id: "artifact-1", visibility: "REVOKED" });
    expect(revokeBuildArtifactPublicAccess).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      reason: "Merged",
    });
  });
});
