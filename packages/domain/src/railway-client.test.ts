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
      .mockResolvedValueOnce({ projectCreate: { id: "project-1" } })
      .mockResolvedValueOnce({ environments: { edges: [{ node: { id: "env-1", name: "production" } }] } })
      .mockResolvedValueOnce({
        web: { id: "web-1" },
        worker: { id: "worker-1" },
        postgres: { id: "postgres-1" },
        redis: { id: "redis-1" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
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
    expect(graphql).toHaveBeenCalledTimes(9);
    expect(graphql.mock.calls[1][0]).toContain("environments(projectId: $projectId");
    expect(graphql.mock.calls[2][0]).toContain("ghcr.io/railwayapp-templates/postgres-ssl:17");
    expect(graphql.mock.calls[2][0]).toContain("bitnami/redis:7.2.5");
    expect(graphql.mock.calls[2][0]).not.toContain("region: $region");
    expect(graphql.mock.calls[3][0]).toContain("serviceInstanceUpdate");
    expect(graphql.mock.calls[3][1]).toMatchObject({
      environmentId: "env-1",
      webInput: { region: "eu-west4" },
      workerInput: { region: "eu-west4" },
      postgresInput: { region: "eu-west4" },
      redisInput: { region: "eu-west4" },
    });
    expect(graphql.mock.calls[4][0]).toContain("volumeCreate");
    expect(graphql.mock.calls[5][1]).toMatchObject({
      projectId: "project-1",
      environmentId: "env-1",
      postgresServiceId: "postgres-1",
      redisServiceId: "redis-1",
      postgresVariables: expect.objectContaining({
        DATABASE_URL: expect.stringContaining("${{Postgres."),
      }),
      redisVariables: expect.objectContaining({
        REDIS_URL: expect.stringContaining("${{Redis."),
      }),
    });
    expect(graphql.mock.calls[6][1]).toMatchObject({
      projectId: "project-1",
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
      variables: {
        APP_URL: "https://acme.corgtex.com",
        DATABASE_URL: "${{Postgres.DATABASE_URL}}",
        REDIS_URL: "${{Redis.REDIS_URL}}",
      },
    });
    expect(graphql.mock.calls[7][0]).toContain("serviceInstanceDeployV2");
  });

  it("provisions runtime services from the public repo with Dockerfile settings", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ projectCreate: { id: "project-1" } })
      .mockResolvedValueOnce({ environments: { edges: [{ node: { id: "env-1", name: "production" } }] } })
      .mockResolvedValueOnce({
        web: { id: "web-1" },
        worker: { id: "worker-1" },
        postgres: { id: "postgres-1" },
        redis: { id: "redis-1" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await provisionRailwayCustomerStack({ graphql }, {
      projectName: "corgtex-acme",
      environmentName: "production",
      region: "us-west2",
      webSource: {
        repo: "Corgtexdotcom/corgtex",
        branch: "main",
        commitSha: "abc123",
        dockerfilePath: "deploy/Dockerfile.web",
      },
      workerSource: {
        repo: "Corgtexdotcom/corgtex",
        branch: "main",
        commitSha: "abc123",
        dockerfilePath: "deploy/Dockerfile.worker",
      },
      variables: {
        APP_URL: "https://acme.corgtex.com",
      },
    });

    expect(graphql).toHaveBeenCalledTimes(8);
    expect(graphql.mock.calls[2][1]).toMatchObject({
      webSource: { repo: "Corgtexdotcom/corgtex" },
      webBranch: "main",
      workerSource: { repo: "Corgtexdotcom/corgtex" },
      workerBranch: "main",
    });
    expect(graphql.mock.calls[3][1]).toMatchObject({
      webInput: {
        region: "us-west2",
        dockerfilePath: "deploy/Dockerfile.web",
      },
      workerInput: {
        region: "us-west2",
        dockerfilePath: "deploy/Dockerfile.worker",
      },
    });
    expect(graphql.mock.calls[7][1]).toMatchObject({
      webCommitSha: "abc123",
      workerCommitSha: "abc123",
    });
  });

  it("rejects runtime services without an image or repository source", async () => {
    await expect(provisionRailwayCustomerStack({ graphql: vi.fn() }, {
      projectName: "corgtex-acme",
      environmentName: "production",
      region: "us-west2",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
      variables: {},
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
      message: "Web service requires either a Docker image or a repository source.",
    });
  });

  it("rejects ambiguous runtime services with both image and repository source", async () => {
    await expect(provisionRailwayCustomerStack({ graphql: vi.fn() }, {
      projectName: "corgtex-acme",
      environmentName: "production",
      region: "us-west2",
      webImage: "ghcr.io/corgtex/web:sha-1",
      webSource: { repo: "Corgtexdotcom/corgtex" },
      workerImage: "ghcr.io/corgtex/worker:sha-1",
      variables: {},
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
      message: "Web service must use either a Docker image or a repository source, not both.",
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
      webInput: { source: { image: "ghcr.io/corgtex/web:sha-2" } },
      workerInput: { source: { image: "ghcr.io/corgtex/worker:sha-2" } },
    });
    expect(graphql.mock.calls[1][1]).toMatchObject({
      projectId: "project-1",
      environmentId: "env-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: "sha-2",
      },
    });
    expect(graphql.mock.calls[2][0]).toContain("serviceInstanceDeployV2");
  });

  it("redeploys selected Railway customer services without updating source or variables", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ deploymentId: "deploy-worker" });
    const { redeployRailwayCustomerServices } = await import("./railway-client");

    const result = await redeployRailwayCustomerServices({ graphql }, {
      environmentId: "env-1",
      services: [{ key: "worker", serviceId: "worker-1" }],
    });

    expect(result).toEqual({
      deployments: [
        { key: "worker", serviceId: "worker-1", deploymentId: "deploy-worker" },
      ],
    });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][0]).toContain("serviceInstanceDeployV2");
    expect(graphql.mock.calls[0][0]).not.toContain("variableCollectionUpsert");
    expect(graphql.mock.calls[0][0]).not.toContain("serviceInstanceUpdate");
    expect(graphql.mock.calls[0][1]).toEqual({
      serviceId: "worker-1",
      environmentId: "env-1",
    });
  });
});
