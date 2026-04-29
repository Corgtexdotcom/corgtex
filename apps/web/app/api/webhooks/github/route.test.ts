import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const markBuildArtifactClosedFromGitHub = vi.fn();

vi.mock("@corgtex/domain", () => ({
  markBuildArtifactClosedFromGitHub,
}));

function signedRequest(payload: Record<string, unknown>, secret = "github-secret") {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return new NextRequest("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

describe("GitHub webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = "github-secret";
    markBuildArtifactClosedFromGitHub.mockResolvedValue({ updatedCount: 1, artifactIds: ["artifact-1"] });
  });

  it("verifies the signature and revokes artifacts for merged pull requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(signedRequest({
      action: "closed",
      repository: {
        name: "corgtex",
        owner: { login: "puncar-dev" },
      },
      pull_request: {
        number: 42,
        merged: true,
        merge_commit_sha: "merge123",
        closed_at: "2026-04-29T12:00:00.000Z",
      },
    }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, updatedCount: 1 });
    expect(markBuildArtifactClosedFromGitHub).toHaveBeenCalledWith({
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      merged: true,
      mergeCommitSha: "merge123",
      closedAt: new Date("2026-04-29T12:00:00.000Z"),
    });
  });

  it("rejects unsigned mutations", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request" },
      body: JSON.stringify({ action: "closed" }),
    }));

    expect(response.status).toBe(401);
    expect(markBuildArtifactClosedFromGitHub).not.toHaveBeenCalled();
  });
});
