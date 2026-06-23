type NodeEnv = "development" | "test" | "production";
type AzureOpenAiAuthMode = "api_key" | "managed_identity";

type RequiredOptions = {
  testFallback?: string;
};

function required(name: string, options: RequiredOptions = {}) {
  const value = process.env[name]?.trim();
  if (!value) {
    if (nodeEnv() === "test" && options.testFallback) {
      return options.testFallback;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function numberFromEnv(name: string, fallback: number) {
  const value = optional(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
}

function booleanFromEnv(name: string, fallback: boolean) {
  const value = optional(name);
  if (!value) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function nodeEnv(): NodeEnv {
  const value = optional("NODE_ENV");
  if (!value) {
    return "development";
  }
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new Error("Invalid NODE_ENV.");
  }
  return value;
}

function azureOpenAiAuthMode(): AzureOpenAiAuthMode {
  const value = optional("AZURE_OPENAI_AUTH_MODE") ?? "api_key";
  if (value !== "api_key" && value !== "managed_identity") {
    throw new Error("Invalid AZURE_OPENAI_AUTH_MODE.");
  }
  return value;
}

type Env = {
  readonly NODE_ENV: NodeEnv;
  readonly DATABASE_URL: string;
  readonly APP_URL: string;
  readonly CONTROL_PLANE_URL: string | undefined;
  readonly MCP_PUBLIC_URL: string | undefined;
  readonly MCP_INSTANCE_REGISTRY: string | undefined;
  readonly MCP_DEFAULT_INSTANCE_SLUG: string | undefined;
  readonly ENTERPRISE_ACCOUNT_DIRECTORY_JSON: string | undefined;
  readonly CONTROL_PLANE_MODE: boolean;
  readonly CONTROL_PLANE_AGENT_API_KEY: string | undefined;
  readonly CONTROL_PLANE_AGENT_SCOPES: string | undefined;
  readonly WORKSPACE_SLUG: string | undefined;
  readonly SESSION_COOKIE_SECRET: string;
  readonly SESSION_LAST_SEEN_WRITE_INTERVAL_MS: number;
  readonly REDIS_URL: string | undefined;
  readonly REDIS_KEY_PREFIX: string;
  readonly AGENT_API_KEY: string | undefined;
  readonly AGENT_ALLOWED_WORKSPACE_IDS: string | undefined;
  readonly MODEL_PROVIDER: string;
  readonly MODEL_API_KEY: string | undefined;
  readonly MODEL_BASE_URL: string | undefined;
  readonly MODEL_PRICE_OVERRIDES_JSON: string | undefined;
  readonly AZURE_OPENAI_AUTH_MODE: AzureOpenAiAuthMode;
  readonly AZURE_OPENAI_API_KEY: string | undefined;
  readonly AZURE_OPENAI_SCOPE: string;
  readonly AZURE_CLIENT_ID: string | undefined;
  readonly MODEL_CHAT_DEFAULT: string;
  readonly MODEL_CHAT_FAST: string;
  readonly MODEL_CHAT_STANDARD: string;
  readonly MODEL_CHAT_QUALITY: string;
  readonly MODEL_CHAT_EXCELLENT: string;
  readonly MODEL_CHAT_CONVERSATION: string;
  readonly MODEL_EMBEDDING_DEFAULT: string;
  readonly MODEL_REQUEST_TIMEOUT_MS: number;
  readonly NEXT_PUBLIC_INTERCOM_APP_ID: string | undefined;
  readonly NEXT_PUBLIC_INTERCOM_API_BASE: string;
  readonly INTERCOM_MESSENGER_SECRET: string | undefined;
  readonly PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID: string | undefined;
  readonly PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG: string | undefined;
  readonly STRIPE_SECRET_KEY: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET: string | undefined;
  readonly STRIPE_PRICE_AI_USAGE_ID: string | undefined;
  readonly AGENT_KILL_SWITCH: boolean;
  readonly WORKSPACE_AGENT_MAX_CONCURRENCY: number;
  readonly WORKER_POLL_INTERVAL_MS: number;
  readonly WORKER_EVENT_BATCH_SIZE: number;
  readonly WORKER_JOB_BATCH_SIZE: number;
  readonly WORKER_HEALTH_PORT: number;
  readonly RESEND_API_KEY: string | undefined;
  readonly EMAIL_FROM: string;
  readonly EMAIL_REPLY_TO: string | undefined;
  readonly SMOKE_EMAIL_CAPTURE_SECRET: string | undefined;
  readonly SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: string | undefined;
  readonly SMOKE_EMAIL_CAPTURE_TTL_MINUTES: number;
  readonly SELF_SERVE_REGISTRY_SYNC_SECRET: string | undefined;
  readonly PROCUREMENT_NOTIFY_EMAIL: string | undefined;
  readonly SENTRY_DSN: string | undefined;
  readonly ENCRYPTION_KEY: string | undefined;
  readonly SLACK_CLIENT_ID: string | undefined;
  readonly SLACK_CLIENT_SECRET: string | undefined;
  readonly SLACK_SIGNING_SECRET: string | undefined;
  readonly SLACK_APP_ID: string | undefined;
  readonly RECALL_API_KEY: string | undefined;
  readonly RECALL_REGION: string;
  readonly RECALL_WEBHOOK_SECRET: string | undefined;
  readonly MEETING_BAAS_API_KEY: string | undefined;
  readonly MEETING_BAAS_WEBHOOK_SECRET: string | undefined;
  readonly MEETING_RECORDER_PUBLIC_BASE_URL: string;
};

const TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/corgtex_test?schema=public";

export const env: Env = {
  get NODE_ENV() {
    return nodeEnv();
  },
  get DATABASE_URL() {
    return required("DATABASE_URL", { testFallback: TEST_DATABASE_URL });
  },
  get APP_URL() {
    return optional("APP_URL") ?? "http://localhost:3000";
  },
  get CONTROL_PLANE_URL() {
    return optional("CONTROL_PLANE_URL");
  },
  get MCP_PUBLIC_URL() {
    return optional("MCP_PUBLIC_URL");
  },
  get MCP_INSTANCE_REGISTRY() {
    return optional("MCP_INSTANCE_REGISTRY");
  },
  get MCP_DEFAULT_INSTANCE_SLUG() {
    return optional("MCP_DEFAULT_INSTANCE_SLUG");
  },
  get ENTERPRISE_ACCOUNT_DIRECTORY_JSON() {
    return optional("ENTERPRISE_ACCOUNT_DIRECTORY_JSON");
  },
  get CONTROL_PLANE_MODE() {
    return booleanFromEnv("CONTROL_PLANE_MODE", false);
  },
  get CONTROL_PLANE_AGENT_API_KEY() {
    return optional("CONTROL_PLANE_AGENT_API_KEY");
  },
  get CONTROL_PLANE_AGENT_SCOPES() {
    return optional("CONTROL_PLANE_AGENT_SCOPES");
  },
  get WORKSPACE_SLUG() {
    return optional("WORKSPACE_SLUG");
  },
  get SESSION_COOKIE_SECRET() {
    if (nodeEnv() === "production") {
      return required("SESSION_COOKIE_SECRET");
    }
    return optional("SESSION_COOKIE_SECRET") ?? "development-session-secret";
  },
  get SESSION_LAST_SEEN_WRITE_INTERVAL_MS() {
    return numberFromEnv("SESSION_LAST_SEEN_WRITE_INTERVAL_MS", 5 * 60 * 1000);
  },
  get REDIS_URL() {
    return optional("REDIS_URL");
  },
  get REDIS_KEY_PREFIX() {
    return optional("REDIS_KEY_PREFIX") ?? "corgtex";
  },
  get AGENT_API_KEY() {
    return optional("AGENT_API_KEY");
  },
  get AGENT_ALLOWED_WORKSPACE_IDS() {
    return optional("AGENT_ALLOWED_WORKSPACE_IDS");
  },
  get MODEL_PROVIDER() {
    return optional("MODEL_PROVIDER") ?? "openrouter";
  },
  get MODEL_API_KEY() {
    return optional("MODEL_API_KEY");
  },
  get MODEL_BASE_URL() {
    return optional("MODEL_BASE_URL") ?? "https://openrouter.ai/api/v1";
  },
  get MODEL_PRICE_OVERRIDES_JSON() {
    return optional("MODEL_PRICE_OVERRIDES_JSON");
  },
  get AZURE_OPENAI_AUTH_MODE() {
    return azureOpenAiAuthMode();
  },
  get AZURE_OPENAI_API_KEY() {
    return optional("AZURE_OPENAI_API_KEY");
  },
  get AZURE_OPENAI_SCOPE() {
    return optional("AZURE_OPENAI_SCOPE") ?? "https://cognitiveservices.azure.com/.default";
  },
  get AZURE_CLIENT_ID() {
    return optional("AZURE_CLIENT_ID");
  },
  get MODEL_CHAT_DEFAULT() {
    return optional("MODEL_CHAT_DEFAULT") ?? "deepseek/deepseek-v4-flash";
  },
  get MODEL_CHAT_FAST() {
    return optional("MODEL_CHAT_FAST") ?? "deepseek/deepseek-v4-flash";
  },
  get MODEL_CHAT_STANDARD() {
    return optional("MODEL_CHAT_STANDARD") ?? "deepseek/deepseek-v4-flash";
  },
  get MODEL_CHAT_QUALITY() {
    return optional("MODEL_CHAT_QUALITY") ?? "deepseek/deepseek-v4-pro";
  },
  get MODEL_CHAT_EXCELLENT() {
    return optional("MODEL_CHAT_EXCELLENT") ?? "deepseek/deepseek-r1-0528";
  },
  get MODEL_CHAT_CONVERSATION() {
    return optional("MODEL_CHAT_CONVERSATION") ?? "deepseek/deepseek-v4-pro";
  },
  get MODEL_EMBEDDING_DEFAULT() {
    return optional("MODEL_EMBEDDING_DEFAULT") ?? "google/gemini-embedding-001";
  },
  get MODEL_REQUEST_TIMEOUT_MS() {
    return numberFromEnv("MODEL_REQUEST_TIMEOUT_MS", 180_000);
  },
  get NEXT_PUBLIC_INTERCOM_APP_ID() {
    return optional("NEXT_PUBLIC_INTERCOM_APP_ID");
  },
  get NEXT_PUBLIC_INTERCOM_API_BASE() {
    return optional("NEXT_PUBLIC_INTERCOM_API_BASE") ?? "https://api-iam.intercom.io";
  },
  get INTERCOM_MESSENGER_SECRET() {
    return optional("INTERCOM_MESSENGER_SECRET");
  },
  get PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID() {
    return optional("PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID");
  },
  get PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG() {
    return optional("PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG");
  },
  get STRIPE_SECRET_KEY() {
    return optional("STRIPE_SECRET_KEY");
  },
  get STRIPE_WEBHOOK_SECRET() {
    return optional("STRIPE_WEBHOOK_SECRET");
  },
  get STRIPE_PRICE_AI_USAGE_ID() {
    return optional("STRIPE_PRICE_AI_USAGE_ID");
  },
  get AGENT_KILL_SWITCH() {
    return booleanFromEnv("AGENT_KILL_SWITCH", false);
  },
  get WORKSPACE_AGENT_MAX_CONCURRENCY() {
    return numberFromEnv("WORKSPACE_AGENT_MAX_CONCURRENCY", 4);
  },
  get WORKER_POLL_INTERVAL_MS() {
    return numberFromEnv("WORKER_POLL_INTERVAL_MS", 2000);
  },
  get WORKER_EVENT_BATCH_SIZE() {
    return numberFromEnv("WORKER_EVENT_BATCH_SIZE", 25);
  },
  get WORKER_JOB_BATCH_SIZE() {
    return numberFromEnv("WORKER_JOB_BATCH_SIZE", 25);
  },
  get WORKER_HEALTH_PORT() {
    return numberFromEnv("WORKER_HEALTH_PORT", 9090);
  },
  get RESEND_API_KEY() {
    return optional("RESEND_API_KEY");
  },
  get EMAIL_FROM() {
    return optional("EMAIL_FROM") ?? "Corgtex <onboarding@resend.dev>";
  },
  get EMAIL_REPLY_TO() {
    return optional("EMAIL_REPLY_TO");
  },
  get SMOKE_EMAIL_CAPTURE_SECRET() {
    return optional("SMOKE_EMAIL_CAPTURE_SECRET");
  },
  get SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS() {
    return optional("SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS");
  },
  get SMOKE_EMAIL_CAPTURE_TTL_MINUTES() {
    return numberFromEnv("SMOKE_EMAIL_CAPTURE_TTL_MINUTES", 30);
  },
  get SELF_SERVE_REGISTRY_SYNC_SECRET() {
    return optional("SELF_SERVE_REGISTRY_SYNC_SECRET");
  },
  get PROCUREMENT_NOTIFY_EMAIL() {
    return optional("PROCUREMENT_NOTIFY_EMAIL");
  },
  get SENTRY_DSN() {
    return optional("NEXT_PUBLIC_SENTRY_DSN") ?? optional("SENTRY_DSN");
  },
  get ENCRYPTION_KEY() {
    return optional("ENCRYPTION_KEY");
  },
  get SLACK_CLIENT_ID() {
    return optional("SLACK_CLIENT_ID");
  },
  get SLACK_CLIENT_SECRET() {
    return optional("SLACK_CLIENT_SECRET");
  },
  get SLACK_SIGNING_SECRET() {
    return optional("SLACK_SIGNING_SECRET");
  },
  get SLACK_APP_ID() {
    return optional("SLACK_APP_ID");
  },
  get RECALL_API_KEY() {
    return optional("RECALL_API_KEY");
  },
  get RECALL_REGION() {
    return optional("RECALL_REGION") ?? "us-east-1";
  },
  get RECALL_WEBHOOK_SECRET() {
    return optional("RECALL_WEBHOOK_SECRET");
  },
  get MEETING_BAAS_API_KEY() {
    return optional("MEETING_BAAS_API_KEY");
  },
  get MEETING_BAAS_WEBHOOK_SECRET() {
    return optional("MEETING_BAAS_WEBHOOK_SECRET");
  },
  get MEETING_RECORDER_PUBLIC_BASE_URL() {
    return optional("MEETING_RECORDER_PUBLIC_BASE_URL") ?? env.APP_URL;
  },
};

export function parseAllowedWorkspaceIds(raw = env.AGENT_ALLOWED_WORKSPACE_IDS) {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
