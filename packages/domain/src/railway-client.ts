import { AppError } from "./errors";

const DEFAULT_RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const POSTGRES_SERVICE_NAME = "Postgres";
const REDIS_SERVICE_NAME = "Redis";
const POSTGRES_VOLUME_MOUNT_PATH = "/var/lib/postgresql/data";
const REDIS_VOLUME_MOUNT_PATH = "/bitnami";

type FetchLike = typeof fetch;
type RailwayBuilder = "HEROKU" | "NIXPACKS" | "PAKETO" | "RAILPACK";

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

export type RailwayRuntimeServiceSource = {
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  rootDirectory?: string | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  builder?: RailwayBuilder | null;
};

export type RailwayProvisioningInput = {
  projectName: string;
  environmentName: string;
  region: string;
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
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
  webImage?: string | null;
  workerImage?: string | null;
  webSource?: RailwayRuntimeServiceSource | null;
  workerSource?: RailwayRuntimeServiceSource | null;
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

function runtimeVariablesWithBackingServices(variables: Record<string, string>) {
  return {
    DATABASE_URL: `\${{${POSTGRES_SERVICE_NAME}.DATABASE_URL}}`,
    REDIS_URL: `\${{${REDIS_SERVICE_NAME}.REDIS_URL}}`,
    ...variables,
  };
}

function postgresServiceVariables() {
  return {
    POSTGRES_DB: "railway",
    POSTGRES_USER: "postgres",
    POSTGRES_PASSWORD: "${{secret(32)}}",
    PGDATA: `${POSTGRES_VOLUME_MOUNT_PATH}/pgdata`,
    DATABASE_URL: `postgresql://\${{${POSTGRES_SERVICE_NAME}.POSTGRES_USER}}:\${{${POSTGRES_SERVICE_NAME}.POSTGRES_PASSWORD}}@\${{${POSTGRES_SERVICE_NAME}.RAILWAY_PRIVATE_DOMAIN}}:5432/\${{${POSTGRES_SERVICE_NAME}.POSTGRES_DB}}`,
  };
}

function redisServiceVariables() {
  return {
    ALLOW_EMPTY_PASSWORD: "no",
    REDIS_PASSWORD: "${{secret(32)}}",
    REDIS_URL: `redis://default:\${{${REDIS_SERVICE_NAME}.REDIS_PASSWORD}}@\${{${REDIS_SERVICE_NAME}.RAILWAY_PRIVATE_DOMAIN}}:6379`,
  };
}

function normalizeOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

type RuntimeServiceSpec = {
  source: { image?: string; repo?: string };
  branch?: string | null;
  commitSha?: string | null;
  rootDirectory?: string | null;
  dockerfilePath?: string | null;
  startCommand?: string | null;
  builder?: RailwayBuilder | null;
};

function requireRuntimeServiceSpec(
  label: string,
  image: string | null | undefined,
  source: RailwayRuntimeServiceSource | null | undefined,
): RuntimeServiceSpec {
  const normalizedImage = normalizeOptional(image);
  const repo = normalizeOptional(source?.repo);

  if (normalizedImage && repo) {
    throw new AppError(400, "INVALID_INPUT", `${label} must use either a Docker image or a repository source, not both.`);
  }

  if (normalizedImage) {
    return {
      source: { image: normalizedImage },
    };
  }

  if (!repo) {
    throw new AppError(400, "INVALID_INPUT", `${label} requires either a Docker image or a repository source.`);
  }

  return {
    source: { repo },
    branch: normalizeOptional(source?.branch),
    commitSha: normalizeOptional(source?.commitSha),
    rootDirectory: normalizeOptional(source?.rootDirectory),
    dockerfilePath: normalizeOptional(source?.dockerfilePath),
    startCommand: normalizeOptional(source?.startCommand),
    builder: source?.builder ?? null,
  };
}

function serviceInstanceSettings(spec: RuntimeServiceSpec, region?: string) {
  const input: Record<string, unknown> = {};
  if (region) {
    input.region = region;
  }
  if (spec.rootDirectory) {
    input.rootDirectory = spec.rootDirectory;
  }
  if (spec.dockerfilePath) {
    input.dockerfilePath = spec.dockerfilePath;
  }
  if (spec.startCommand) {
    input.startCommand = spec.startCommand;
  }
  if (spec.builder) {
    input.builder = spec.builder;
  }
  return input;
}

function serviceInstanceUpdateInput(spec: RuntimeServiceSpec, region?: string) {
  return {
    source: spec.source,
    ...serviceInstanceSettings(spec, region),
  };
}

async function resolveRailwayEnvironmentId(client: RailwayClient, projectId: string, environmentName: string) {
  const normalizedEnvironmentName = normalizeOptional(environmentName) ?? "production";
  const environments = await client.graphql<{
    environments: {
      edges?: Array<{ node?: { id: string; name: string } | null }>;
    };
  }>(
    `query ListProjectEnvironments($projectId: String!) {
      environments(projectId: $projectId, isEphemeral: false) {
        edges { node { id name } }
      }
    }`,
    { projectId },
  );

  const existing = environments.environments.edges
    ?.map((edge) => edge.node)
    .find((environment) => environment?.name === normalizedEnvironmentName);
  if (existing?.id) {
    return existing.id;
  }

  const created = await client.graphql<{
    environmentCreate: { id: string; name: string };
  }>(
    `mutation CreateEnvironment($input: EnvironmentCreateInput!) {
      environmentCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId,
        name: normalizedEnvironmentName,
      },
    },
  );

  return created.environmentCreate.id;
}

export async function provisionRailwayCustomerStack(
  client: RailwayClient,
  input: RailwayProvisioningInput,
): Promise<RailwayProvisioningResult> {
  const webSpec = requireRuntimeServiceSpec("Web service", input.webImage, input.webSource);
  const workerSpec = requireRuntimeServiceSpec("Worker service", input.workerImage, input.workerSource);

  const project = await client.graphql<{
    projectCreate: { id: string };
  }>(
    `mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    {
      input: {
        name: input.projectName,
        defaultEnvironmentName: input.environmentName,
      },
    },
  );

  const projectId = project.projectCreate.id;
  const environmentId = await resolveRailwayEnvironmentId(client, projectId, input.environmentName);

  const services = await client.graphql<{
    web: { id: string };
    worker: { id: string };
    postgres: { id: string };
    redis: { id: string };
  }>(
    `mutation CreateServices(
      $projectId: String!
      $environmentId: String!
      $webSource: ServiceSourceInput!
      $webBranch: String
      $workerSource: ServiceSourceInput!
      $workerBranch: String
    ) {
      web: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "web"
        source: $webSource
        branch: $webBranch
      }) { id }
      worker: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "worker"
        source: $workerSource
        branch: $workerBranch
      }) { id }
      postgres: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "Postgres"
        source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:17" }
      }) { id }
      redis: serviceCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        name: "Redis"
        source: { image: "bitnami/redis:7.2.5" }
      }) { id }
    }`,
    {
      projectId,
      environmentId,
      webSource: webSpec.source,
      webBranch: webSpec.branch,
      workerSource: workerSpec.source,
      workerBranch: workerSpec.branch,
    },
  );

  await client.graphql<unknown>(
    `mutation ConfigureServiceInstances(
      $environmentId: String!
      $webServiceId: String!
      $workerServiceId: String!
      $postgresServiceId: String!
      $redisServiceId: String!
      $webInput: ServiceInstanceUpdateInput!
      $workerInput: ServiceInstanceUpdateInput!
      $postgresInput: ServiceInstanceUpdateInput!
      $redisInput: ServiceInstanceUpdateInput!
    ) {
      web: serviceInstanceUpdate(
        serviceId: $webServiceId
        environmentId: $environmentId
        input: $webInput
      )
      worker: serviceInstanceUpdate(
        serviceId: $workerServiceId
        environmentId: $environmentId
        input: $workerInput
      )
      postgres: serviceInstanceUpdate(
        serviceId: $postgresServiceId
        environmentId: $environmentId
        input: $postgresInput
      )
      redis: serviceInstanceUpdate(
        serviceId: $redisServiceId
        environmentId: $environmentId
        input: $redisInput
      )
    }`,
    {
      environmentId,
      webServiceId: services.web.id,
      workerServiceId: services.worker.id,
      postgresServiceId: services.postgres.id,
      redisServiceId: services.redis.id,
      webInput: serviceInstanceSettings(webSpec, input.region),
      workerInput: serviceInstanceSettings(workerSpec, input.region),
      postgresInput: { region: input.region },
      redisInput: { region: input.region },
    },
  );

  await client.graphql<unknown>(
    `mutation CreateBackingServiceVolumes(
      $projectId: String!
      $environmentId: String!
      $postgresServiceId: String!
      $redisServiceId: String!
      $postgresMountPath: String!
      $redisMountPath: String!
    ) {
      postgres: volumeCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $postgresServiceId
        name: "postgres-data"
        mountPath: $postgresMountPath
      }) { id }
      redis: volumeCreate(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $redisServiceId
        name: "redis-data"
        mountPath: $redisMountPath
      }) { id }
    }`,
    {
      projectId,
      environmentId,
      postgresServiceId: services.postgres.id,
      redisServiceId: services.redis.id,
      postgresMountPath: POSTGRES_VOLUME_MOUNT_PATH,
      redisMountPath: REDIS_VOLUME_MOUNT_PATH,
    },
  );

  await client.graphql<unknown>(
    `mutation UpsertBackingServiceVariables(
      $projectId: String!
      $environmentId: String!
      $postgresServiceId: String!
      $redisServiceId: String!
      $postgresVariables: EnvironmentVariables!
      $redisVariables: EnvironmentVariables!
    ) {
      postgres: variableCollectionUpsert(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $postgresServiceId
        variables: $postgresVariables
        replace: false
      })
      redis: variableCollectionUpsert(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $redisServiceId
        variables: $redisVariables
        replace: false
      })
    }`,
    {
      projectId,
      environmentId,
      postgresServiceId: services.postgres.id,
      redisServiceId: services.redis.id,
      postgresVariables: postgresServiceVariables(),
      redisVariables: redisServiceVariables(),
    },
  );

  await client.graphql<unknown>(
    `mutation UpsertVariables(
      $projectId: String!
      $environmentId: String!
      $webServiceId: String!
      $workerServiceId: String!
      $variables: EnvironmentVariables!
    ) {
      web: variableCollectionUpsert(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $webServiceId
        variables: $variables
        replace: false
      })
      worker: variableCollectionUpsert(input: {
        projectId: $projectId
        environmentId: $environmentId
        serviceId: $workerServiceId
        variables: $variables
        replace: false
      })
    }`,
    {
      projectId,
      environmentId,
      webServiceId: services.web.id,
      workerServiceId: services.worker.id,
      variables: runtimeVariablesWithBackingServices(input.variables),
    },
  );

  await client.graphql<unknown>(
    `mutation DeployServices(
      $webServiceId: String!
      $workerServiceId: String!
      $postgresServiceId: String!
      $redisServiceId: String!
      $environmentId: String!
      $webCommitSha: String
      $workerCommitSha: String
    ) {
      web: serviceInstanceDeployV2(serviceId: $webServiceId, environmentId: $environmentId, commitSha: $webCommitSha)
      worker: serviceInstanceDeployV2(serviceId: $workerServiceId, environmentId: $environmentId, commitSha: $workerCommitSha)
      postgres: serviceInstanceDeployV2(serviceId: $postgresServiceId, environmentId: $environmentId)
      redis: serviceInstanceDeployV2(serviceId: $redisServiceId, environmentId: $environmentId)
    }`,
    {
      webServiceId: services.web.id,
      workerServiceId: services.worker.id,
      postgresServiceId: services.postgres.id,
      redisServiceId: services.redis.id,
      environmentId,
      webCommitSha: webSpec.commitSha,
      workerCommitSha: workerSpec.commitSha,
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
  const webSpec = requireRuntimeServiceSpec("Web service", input.webImage, input.webSource);
  const workerSpec = requireRuntimeServiceSpec("Worker service", input.workerImage, input.workerSource);

  await client.graphql<unknown>(
    `mutation UpdateServiceSources(
      $environmentId: String!
      $webServiceId: String!
      $workerServiceId: String!
      $webInput: ServiceInstanceUpdateInput!
      $workerInput: ServiceInstanceUpdateInput!
    ) {
      web: serviceInstanceUpdate(
        serviceId: $webServiceId
        environmentId: $environmentId
        input: $webInput
      )
      worker: serviceInstanceUpdate(
        serviceId: $workerServiceId
        environmentId: $environmentId
        input: $workerInput
      )
    }`,
    {
      environmentId: input.environmentId,
      webServiceId: input.webServiceId,
      workerServiceId: input.workerServiceId,
      webInput: serviceInstanceUpdateInput(webSpec),
      workerInput: serviceInstanceUpdateInput(workerSpec),
    },
  );

  if (input.variables && Object.keys(input.variables).length > 0) {
    await client.graphql<unknown>(
      `mutation UpsertUpgradeVariables(
        $projectId: String!
        $environmentId: String!
        $webServiceId: String!
        $workerServiceId: String!
        $variables: EnvironmentVariables!
      ) {
        web: variableCollectionUpsert(input: {
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $webServiceId
          variables: $variables
          replace: false
        })
        worker: variableCollectionUpsert(input: {
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $workerServiceId
          variables: $variables
          replace: false
        })
      }`,
      {
        projectId: input.projectId,
        environmentId: input.environmentId,
        webServiceId: input.webServiceId,
        workerServiceId: input.workerServiceId,
        variables: input.variables,
      },
    );
  }

  const deployments = await client.graphql<{
    web: string | null;
    worker: string | null;
  }>(
    `mutation DeployUpdatedServices(
      $webServiceId: String!
      $workerServiceId: String!
      $environmentId: String!
      $webCommitSha: String
      $workerCommitSha: String
    ) {
      web: serviceInstanceDeployV2(serviceId: $webServiceId, environmentId: $environmentId, commitSha: $webCommitSha)
      worker: serviceInstanceDeployV2(serviceId: $workerServiceId, environmentId: $environmentId, commitSha: $workerCommitSha)
    }`,
    {
      webServiceId: input.webServiceId,
      workerServiceId: input.workerServiceId,
      environmentId: input.environmentId,
      webCommitSha: webSpec.commitSha,
      workerCommitSha: workerSpec.commitSha,
    },
  );

  return {
    webDeploymentId: deployments.web,
    workerDeploymentId: deployments.worker,
  };
}
