import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

function railwayRequest(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/webhooks/railway", {
    method: "POST",
    headers: {
      authorization: "Bearer railway-secret",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

describe("Railway webhook route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.stubEnv("RAILWAY_WEBHOOK_SECRET", "railway-secret");
    vi.stubEnv("OPS_SLACK_WEBHOOK_URL", "https://hooks.slack.test/services/ops");
    vi.stubEnv("OPS_GITHUB_TOKEN", "github-token");
    vi.stubEnv("OPS_GITHUB_REPOSITORY", "corgtex/corgtex");
  });

  it("rejects unsigned Railway webhooks", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/webhooks/railway", {
      method: "POST",
      body: JSON.stringify({ type: "deployment.failed" }),
    }));

    expect(response.status).toBe(401);
  });

  it("posts Slack and GitHub incidents for failed deployments", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://hooks.slack.test/")) {
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/labels")) {
        return Response.json({ name: "label" }, { status: 201 });
      }
      if (url.includes("/issues?")) {
        return Response.json([], { status: 200 });
      }
      if (url.endsWith("/issues")) {
        return Response.json({ html_url: "https://github.test/corgtex/corgtex/issues/1" }, { status: 201 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(railwayRequest({
      type: "deployment.failed",
      service: { name: "web" },
      environment: { name: "production" },
      deployment: {
        id: "deployment-1",
        status: "FAILED",
      },
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      actionable: true,
      githubUrl: "https://github.test/corgtex/corgtex/issues/1",
      slackSent: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/services/ops",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/corgtex/corgtex/issues",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("deployment-1"),
      }),
    );
  });

  it("keeps generic failed deployment events out of GitHub incidents", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://hooks.slack.test/")) {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(railwayRequest({
      type: "Deployment.crashed",
      status: "Deployment.crashed",
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      actionable: false,
      githubUrl: null,
      slackSent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/services/ops",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not create GitHub incidents for successful deployment events", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://hooks.slack.test/")) {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(railwayRequest({
      type: "deployment.succeeded",
      service: { name: "web" },
      deployment: { status: "SUCCESS" },
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      actionable: false,
      githubUrl: null,
      slackSent: true,
    });
  });
});
