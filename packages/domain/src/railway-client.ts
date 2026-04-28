import { AppError } from "./errors";

const DEFAULT_RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.app/graphql/v2";

type FetchLike = typeof fetch;

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export type RailwayClient = {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};

export type RailwayClientOptions = {
  token: string;
  endpoint?: string;
  fetchImpl?: FetchLike;
};

export type RailwayProvisioningInput = {
  projectName: string;
  environmentName: string;
  region: string;
  webImage: string;
  workerImage: string;
  variables: Record<string, string>;
  customDomain?: string | null;
};

export type RailwayProvisioningResult = {
  projectId: string;
  environmentId: string;
  webServiceId: string;
  workerServiceId: string;
  postgresServiceId: string;
  redisServiceId: string;
  webDomain?: string | null;
};

export type RailwayReleaseUpgradeInput = {
  projectId: string;
  environmentId: string;
  webServiceId: string;
  workerServiceId: string;
  webImage: string;
  workerImage: string;
  variables?: Record<string, string>;
};

export type RailwayReleaseUpgradeResult = {
  webDeploymentId?: string | null;
  workerDeploymentId?: string | null;
};

export function createRailwayClient(options: RailwayClientOptions): RailwayClient {
  const token = options.token.trim();
  if (!token) {
    throw new AppError(500, "RAILWAY_TOKEN_MISSING", "Railway API token is not configured.");
  }

  const endpoint = options.endpoint?.trim() || DEFAULT_RAILWAY_GRAPHQL_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      const body = (await response.json()) as GraphqlResponse<T>;
      if (!response.ok || body.errors?.length) {
        const message = body.errors?.map((error) => error.message).filter(Boolean).join("; ")
          || `Railway API request failed with status ${response.status}.`;
        throw new AppError(502, "RAILWAY_API_ERROR", message);
      }

      if (!body.data) {
        throw new AppError(502, "RAILWAY_API_ERROR", "Railway API returned no data.");
      }

      return body.data;
    },
  };
}

export function createRailwayClientFromEnv() {
  return createRailwayClient({
    token: process.env.RAILWAY_API_TOKEN ?? "",
    endpoint: process.env.RAILWAY_GRAPHQL_ENDPOINT,
  });
}

export async function provisionRailwayCustomerStack(
  client: RailwayClient,
  input: RailwayProvisioningInput,
): Promise<RailwayProvisioningResult> {
  const project = await client.graphql<{
    projectCreate: { id: string; defaultEnvironment: { id: string } | null };
  }>(
    `mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        defaultEnvironment { id }
      }
    }`,
    {
      input: {
        name: input.projectName,
        defaultEnvironmentName: input.environmentName,
      },
    },
  );

  const projectId = project.projectCreate.id;
  const environmentId = project.projectCreate.defaultEnvironment?.id;
  if (!environmentId) {
    throw new AppError(502, "RAILWAY_API_ERROR", "Railway project did not include a default environment.");
  }

  const services = await client.graphql<{
    web: { id: string };
    worker: { id: string };
    postgres: { id: string };
    redis: { id: string };
  }>(
    `mutation CreateServices(
      $projectId: String!
      $environmentId: String!
      $region: String!
      $webImage: String!
      $workerImage: String!
    ) {
      web: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "web"
        source: { image: $webImage }
        region: $region
      }) { id }
      worker: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "worker"
        source: { image: $workerImage }
        region: $region
      }) { id }
      postgres: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "Postgres"
        source: { image: "postgres:16-alpine" }
        region: $region
      }) { id }
      redis: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "Redis"
        source: { image: "redis:7-alpine" }
        region: $region
      }) { id }
    }`,
    {
      projectId,
      environmentId,
      region: input.region,
      webImage: input.webImage,
      workerImage: input.workerImage,
    },
  );

  await client.graphql<unknown>(
    `mutation UpsertVariables(
      $projectId: String!
      $environmentId: String!
      $serviceId: String!
      $variables: EnvironmentVariables!
    ) {
      variableCollectionUpsert(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $serviceId
        variables: $variables
      })
    }`,
    {
      projectId,
      environmentId,
      serviceId: services.web.id,
      variables: input.variables,
    },
  );

  await client.graphql<unknown>(
    `mutation DeployServices($webServiceId: String!, $workerServiceId: String!, $environmentId: String!) {
      web: serviceInstanceRedeploy(serviceId: $webServiceId, environmentId: $environmentId)
      worker: serviceInstanceRedeploy(serviceId: $workerServiceId, environmentId: $environmentId)
    }`,
    {
      webServiceId: services.web.id,
      workerServiceId: services.worker.id,
      environmentId,
    },
  );

  let webDomain: string | null = null;
  if (input.customDomain) {
    const domain = await client.graphql<{ customDomainCreate: { domain: string } }>(
      `mutation CreateCustomDomain($environmentId: String!, $serviceId: String!, $domain: String!) {
        customDomainCreate(input: {
          environmentId: $environmentId
          serviceId: $serviceId
          domain: $domain
        }) { domain }
      }`,
      {
        environmentId,
        serviceId: services.web.id,
        domain: input.customDomain,
      },
    );
    webDomain = domain.customDomainCreate.domain;
  }

  return {
    projectId,
    environmentId,
    webServiceId: services.web.id,
    workerServiceId: services.worker.id,
    postgresServiceId: services.postgres.id,
    redisServiceId: services.redis.id,
    webDomain,
  };
}

export async function upgradeRailwayCustomerRelease(
  client: RailwayClient,
  input: RailwayReleaseUpgradeInput,
): Promise<RailwayReleaseUpgradeResult> {
  await client.graphql<unknown>(
    `mutation UpdateServiceImages(
      $environmentId: String!
      $webServiceId: String!
      $workerServiceId: String!
      $webImage: String!
      $workerImage: String!
    ) {
      web: serviceInstanceUpdate(
        serviceId: $webServiceId
        environmentId: $environmentId
        input: { source: { image: $webImage } }
      ) { id }
      worker: serviceInstanceUpdate(
        serviceId: $workerServiceId
        environmentId: $environmentId
        input: { source: { image: $workerImage } }
      ) { id }
    }`,
    {
      environmentId: input.environmentId,
      webServiceId: input.webServiceId,
      workerServiceId: input.workerServiceId,
      webImage: input.webImage,
      workerImage: input.workerImage,
    },
  );

  if (input.variables && Object.keys(input.variables).length > 0) {
    await client.graphql<unknown>(
      `mutation UpsertUpgradeVariables(
        $projectId: String!
        $environmentId: String!
        $serviceId: String!
        $variables: EnvironmentVariables!
      ) {
        variableCollectionUpsert(input: {
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $serviceId
          variables: $variables
          replace: false
        })
      }`,
      {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.webServiceId,
        variables: input.variables,
      },
    );
  }

  const deployments = await client.graphql<{
    web: string | null;
    worker: string | null;
  }>(
    `mutation RedeployUpdatedServices($webServiceId: String!, $workerServiceId: String!, $environmentId: String!) {
      web: serviceInstanceRedeploy(serviceId: $webServiceId, environmentId: $environmentId)
      worker: serviceInstanceRedeploy(serviceId: $workerServiceId, environmentId: $environmentId)
    }`,
    {
      webServiceId: input.webServiceId,
      workerServiceId: input.workerServiceId,
      environmentId: input.environmentId,
    },
  );

  return {
    webDeploymentId: deployments.web,
    workerDeploymentId: deployments.worker,
  };
}
