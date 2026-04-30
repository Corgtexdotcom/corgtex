import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const markBuildArtifactClosedFromGitHub = vi.fn();
const upsertBuildArtifactsFromGitHubPullRequest = vi.fn();

vi.mock("@corgtex/domain", () => ({
  markBuildArtifactClosedFromGitHub,
  upsertBuildArtifactsFromGitHubPullRequest,
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
    upsertBuildArtifactsFromGitHubPullRequest.mockResolvedValue({ updatedCount: 1, artifactIds: ["artifact-1"] });
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

  it("syncs active pull request events into build artifacts", async () => {
    const { POST } = await import("./route");
    const response = await POST(signedRequest({
      action: "opened",
      repository: {
        name: "corgtex",
        owner: { login: "puncar-dev" },
      },
      pull_request: {
        number: 42,
        html_url: "https://github.com/puncar-dev/corgtex/pull/42",
        title: "Built outcome board",
        body: "Plan and acceptance criteria.",
        draft: true,
        head: {
          ref: "feat/outcome-board",
          sha: "abc123",
        },
      },
    }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, updatedCount: 1 });
    expect(upsertBuildArtifactsFromGitHubPullRequest).toHaveBeenCalledWith({
      repositoryOwner: "puncar-dev",
      repositoryName: "corgtex",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/puncar-dev/corgtex/pull/42",
      branchName: "feat/outcome-board",
      commitSha: "abc123",
      title: "Built outcome board",
      bodyMd: "Plan and acceptance criteria.",
      isDraft: true,
    });
    expect(markBuildArtifactClosedFromGitHub).not.toHaveBeenCalled();
  });

  it("updates active pull request artifacts when review state changes", async () => {
    const { POST } = await import("./route");
    const response = await POST(signedRequest({
      action: "ready_for_review",
      repository: {
        name: "corgtex",
        owner: { login: "puncar-dev" },
      },
      pull_request: {
        number: 43,
        html_url: "https://github.com/puncar-dev/corgtex/pull/43",
        title: "Ready work",
        body: null,
        draft: false,
        head: {
          ref: "feat/ready",
          sha: "def456",
        },
      },
    }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, updatedCount: 1 });
    expect(upsertBuildArtifactsFromGitHubPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 43,
      isDraft: false,
      commitSha: "def456",
    }));
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
    expect(upsertBuildArtifactsFromGitHubPullRequest).not.toHaveBeenCalled();
  });
});
