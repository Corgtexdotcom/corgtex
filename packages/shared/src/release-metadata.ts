type ReleaseProvider = "azure" | "local" | "railway" | "vercel";
type ReleaseValueSource =
  | "azure"
  | "configured"
  | "development"
  | "github"
  | "image_tag"
  | "missing"
  | "package"
  | "railway"
  | "vercel";

export type ReleaseMetadata = {
  version: string;
  imageTag: string | null;
  gitSha: string | null;
  buildTime: string | null;
  environment: string;
  provider: ReleaseProvider;
  service: string;
  source: {
    version: ReleaseValueSource;
    imageTag: ReleaseValueSource;
    gitSha: ReleaseValueSource;
    buildTime: ReleaseValueSource;
    environment: ReleaseValueSource;
    service: ReleaseValueSource;
  };
  runtime: {
    gitSha: string | null;
    source: ReleaseValueSource;
  };
  configured: {
    version: string | null;
    imageTag: string | null;
    gitSha: string | null;
    buildTime: string | null;
    environment: string | null;
    service: string | null;
  };
  drift: {
    version: boolean;
    imageTag: boolean;
    gitSha: boolean;
    details: string[];
  };
};

type ReleaseMetadataOptions = {
  service?: string;
};

function optional(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function runtimeProvider(env: NodeJS.ProcessEnv): ReleaseProvider {
  if (optional(env, "RAILWAY_SERVICE_ID") || optional(env, "RAILWAY_GIT_COMMIT_SHA")) return "railway";
  if (optional(env, "VERCEL")) return "vercel";
  if (optional(env, "WEBSITE_SITE_NAME") || optional(env, "CONTAINER_APP_NAME") || optional(env, "APPLICATIONINSIGHTS_CONNECTION_STRING")) return "azure";
  return "local";
}

function runtimeGitSha(env: NodeJS.ProcessEnv) {
  const railway = optional(env, "RAILWAY_GIT_COMMIT_SHA");
  if (railway) return { value: railway, source: "railway" as const };

  const vercel = optional(env, "VERCEL_GIT_COMMIT_SHA");
  if (vercel) return { value: vercel, source: "vercel" as const };

  const github = optional(env, "GITHUB_SHA");
  if (github) return { value: github, source: "github" as const };

  return { value: null, source: "missing" as const };
}

function imageTagSha(imageTag: string | null) {
  if (!imageTag) return null;
  if (imageTag.startsWith("sha-")) return imageTag.slice("sha-".length);
  if (/^[0-9a-f]{40}$/i.test(imageTag)) return imageTag;
  return null;
}

export function releaseVersionForGitSha(gitSha: string) {
  return `main-${gitSha.slice(0, 12)}`;
}

function environmentName(env: NodeJS.ProcessEnv) {
  return optional(env, "CORGTEX_ENVIRONMENT")
    ?? optional(env, "POSTHOG_ENVIRONMENT")
    ?? optional(env, "RAILWAY_ENVIRONMENT_NAME")
    ?? optional(env, "NEXT_PUBLIC_VERCEL_ENV")
    ?? optional(env, "NODE_ENV")
    ?? "development";
}

function environmentSource(env: NodeJS.ProcessEnv): ReleaseValueSource {
  if (optional(env, "CORGTEX_ENVIRONMENT") || optional(env, "POSTHOG_ENVIRONMENT")) return "configured";
  if (optional(env, "RAILWAY_ENVIRONMENT_NAME")) return "railway";
  if (optional(env, "NEXT_PUBLIC_VERCEL_ENV")) return "vercel";
  if (optional(env, "NODE_ENV")) return "configured";
  return "development";
}

function serviceName(env: NodeJS.ProcessEnv, options: ReleaseMetadataOptions) {
  return options.service?.trim()
    || optional(env, "CORGTEX_SERVICE_NAME")
    || optional(env, "POSTHOG_INSTANCE_ID")
    || optional(env, "MCP_DEFAULT_INSTANCE_SLUG")
    || optional(env, "WORKSPACE_SLUG")
    || optional(env, "RAILWAY_SERVICE_NAME")
    || optional(env, "WEBSITE_SITE_NAME")
    || optional(env, "CONTAINER_APP_NAME")
    || optional(env, "npm_package_name")
    || "corgtex";
}

function serviceSource(env: NodeJS.ProcessEnv, options: ReleaseMetadataOptions): ReleaseValueSource {
  if (options.service?.trim()) return "configured";
  if (optional(env, "CORGTEX_SERVICE_NAME") || optional(env, "POSTHOG_INSTANCE_ID") || optional(env, "MCP_DEFAULT_INSTANCE_SLUG") || optional(env, "WORKSPACE_SLUG")) {
    return "configured";
  }
  if (optional(env, "RAILWAY_SERVICE_NAME")) return "railway";
  if (optional(env, "WEBSITE_SITE_NAME") || optional(env, "CONTAINER_APP_NAME")) return "azure";
  if (optional(env, "npm_package_name")) return "package";
  return "development";
}

function driftDetails(params: {
  configuredGitSha: string | null;
  configuredImageTag: string | null;
  configuredVersion: string | null;
  runtimeGitSha: string | null;
}) {
  const details: string[] = [];
  const { configuredGitSha, configuredImageTag, configuredVersion, runtimeGitSha } = params;
  if (!runtimeGitSha) {
    return {
      version: false,
      imageTag: false,
      gitSha: false,
      details,
    };
  }

  const expectedVersion = releaseVersionForGitSha(runtimeGitSha);
  const expectedImageTags = new Set([runtimeGitSha, `sha-${runtimeGitSha}`]);
  const gitSha = Boolean(configuredGitSha && configuredGitSha !== runtimeGitSha);
  const imageTag = Boolean(configuredImageTag && !expectedImageTags.has(configuredImageTag));
  const version = Boolean(configuredVersion?.startsWith("main-") && configuredVersion !== expectedVersion);

  if (gitSha) {
    details.push(`configured.gitSha=${configuredGitSha} does not match runtime.gitSha=${runtimeGitSha}`);
  }
  if (imageTag) {
    details.push(`configured.imageTag=${configuredImageTag} does not match runtime git SHA ${runtimeGitSha}`);
  }
  if (version) {
    details.push(`configured.version=${configuredVersion} does not match expected ${expectedVersion}`);
  }

  return { version, imageTag, gitSha, details };
}

export function resolveReleaseMetadata(
  env: NodeJS.ProcessEnv = process.env,
  options: ReleaseMetadataOptions = {},
): ReleaseMetadata {
  const configuredVersion = optional(env, "CORGTEX_RELEASE_VERSION");
  const configuredImageTag = optional(env, "CORGTEX_RELEASE_IMAGE_TAG");
  const configuredGitSha = optional(env, "CORGTEX_RELEASE_GIT_SHA");
  const configuredBuildTime = optional(env, "CORGTEX_RELEASE_BUILD_TIME");
  const configuredEnvironment = optional(env, "CORGTEX_ENVIRONMENT") ?? optional(env, "POSTHOG_ENVIRONMENT");
  const configuredService = optional(env, "CORGTEX_SERVICE_NAME") ?? options.service?.trim() ?? null;
  const packageVersion = optional(env, "npm_package_version");
  const runtime = runtimeGitSha(env);
  const imageDerivedGitSha = imageTagSha(configuredImageTag);
  const gitSha = runtime.value ?? configuredGitSha ?? imageDerivedGitSha;
  const gitShaSource = runtime.value
    ? runtime.source
    : configuredGitSha
      ? "configured"
      : imageDerivedGitSha
        ? "image_tag"
        : "missing";
  const buildTimeSource = configuredBuildTime ? "configured" : "missing";

  return {
    version: configuredVersion ?? packageVersion ?? "development",
    imageTag: configuredImageTag,
    gitSha,
    buildTime: configuredBuildTime,
    environment: environmentName(env),
    provider: runtimeProvider(env),
    service: serviceName(env, options),
    source: {
      version: configuredVersion ? "configured" : packageVersion ? "package" : "development",
      imageTag: configuredImageTag ? "configured" : "missing",
      gitSha: gitShaSource,
      buildTime: buildTimeSource,
      environment: environmentSource(env),
      service: serviceSource(env, options),
    },
    runtime: {
      gitSha: runtime.value,
      source: runtime.source,
    },
    configured: {
      version: configuredVersion,
      imageTag: configuredImageTag,
      gitSha: configuredGitSha,
      buildTime: configuredBuildTime,
      environment: configuredEnvironment,
      service: configuredService,
    },
    drift: driftDetails({
      configuredGitSha,
      configuredImageTag,
      configuredVersion,
      runtimeGitSha: runtime.value,
    }),
  };
}
