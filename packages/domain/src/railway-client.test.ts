import { describe, expect, it, vi } from "vitest";

import {
  createRailwayClient,
  provisionRailwayCustomerStack,
  upgradeRailwayCustomerRelease,
} from "./railway-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Railway client", () => {
  it("sends authenticated GraphQL requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { viewer: { id: "u_1" } } }));
    const client = createRailwayClient({
      token: "railway-token",
      endpoint: "https://railway.test/graphql",
      fetchImpl: fetchImpl as any,
    });

    await expect(client.graphql("query { viewer { id } }")).resolves.toEqual({ viewer: { id: "u_1" } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://railway.test/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer railway-token",
        }),
      }),
    );
  });

  it("maps GraphQL errors to AppError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      errors: [{ message: "not allowed" }],
    }));
    const client = createRailwayClient({
      token: "railway-token",
      endpoint: "https://railway.test/graphql",
      fetchImpl: fetchImpl as any,
    });

    await expect(client.graphql("query { nope }")).rejects.toMatchObject({
      status: 502,
      code: "RAILWAY_API_ERROR",
      message: "not allowed",
    });
  });

  it("provisions the customer stack with project, services, variables, deploys, and domain", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ projectCreate: { id: "project-1", defaultEnvironment: { id: "env-1" } } })
      .mockResolvedValueOnce({
        web: { id: "web-1" },
        worker: { id: "worker-1" },
        postgres: { id: "postgres-1" },
        redis: { id: "redis-1" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ customDomainCreate: { domain: "acme.corgtex.com" } });

    const result = await provisionRailwayCustomerStack({ graphql }, {
      projectName: "corgtex-acme",
      environmentName: "production",
      region: "eu-west4",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
      customDomain: "acme.corgtex.com",
      variables: {
        APP_URL: "https://acme.corgtex.com",
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
      postgresServiceId: "postgres-1",
      redisServiceId: "redis-1",
      webDomain: "acme.corgtex.com",
    });
    expect(graphql).toHaveBeenCalledTimes(5);
    expect(graphql.mock.calls[2][1]).toMatchObject({
      projectId: "project-1",
      environmentId: "env-1",
      serviceId: "web-1",
      variables: {
        APP_URL: "https://acme.corgtex.com",
      },
    });
  });

  it("upgrades service images, release variables, and redeploys both runtime services", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ web: "deploy-web", worker: "deploy-worker" });

    const result = await upgradeRailwayCustomerRelease({ graphql }, {
      projectId: "project-1",
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
      webImage: "ghcr.io/corgtex/web:sha-2",
      workerImage: "ghcr.io/corgtex/worker:sha-2",
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: "sha-2",
      },
    });

    expect(result).toEqual({
      webDeploymentId: "deploy-web",
      workerDeploymentId: "deploy-worker",
    });
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[0][1]).toMatchObject({
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
      webImage: "ghcr.io/corgtex/web:sha-2",
      workerImage: "ghcr.io/corgtex/worker:sha-2",
    });
    expect(graphql.mock.calls[1][1]).toMatchObject({
      projectId: "project-1",
      environmentId: "env-1",
      serviceId: "web-1",
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: "sha-2",
      },
    });
  });
});
