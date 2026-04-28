type NodeEnv = "development" | "test" | "production";

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

type Env = {
  readonly NODE_ENV: NodeEnv;
  readonly DATABASE_URL: string;
  readonly APP_URL: string;
  readonly MCP_PUBLIC_URL: string | undefined;
  readonly MCP_INSTANCE_REGISTRY: string | undefined;
  readonly MCP_DEFAULT_INSTANCE_SLUG: string | undefined;
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
  readonly MODEL_CHAT_DEFAULT: string;
  readonly MODEL_CHAT_FAST: string;
  readonly MODEL_CHAT_STANDARD: string;
  readonly MODEL_CHAT_QUALITY: string;
  readonly MODEL_CHAT_CONVERSATION: string;
  readonly MODEL_EMBEDDING_DEFAULT: string;
  readonly AGENT_KILL_SWITCH: boolean;
  readonly WORKSPACE_AGENT_MAX_CONCURRENCY: number;
  readonly WORKER_POLL_INTERVAL_MS: number;
  readonly WORKER_EVENT_BATCH_SIZE: number;
  readonly WORKER_JOB_BATCH_SIZE: number;
  readonly WORKER_HEALTH_PORT: number;
  readonly RESEND_API_KEY: string | undefined;
  readonly EMAIL_FROM: string;
  readonly EMAIL_REPLY_TO: string | undefined;
  readonly PROCUREMENT_NOTIFY_EMAIL: string | undefined;
  readonly SENTRY_DSN: string | undefined;
  readonly ENCRYPTION_KEY: string | undefined;
  readonly SLACK_CLIENT_ID: string | undefined;
  readonly SLACK_CLIENT_SECRET: string | undefined;
  readonly SLACK_SIGNING_SECRET: string | undefined;
  readonly SLACK_APP_ID: string | undefined;
};

const TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/corgtex_test";

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
  get MCP_PUBLIC_URL() {
    return optional("MCP_PUBLIC_URL");
  },
  get MCP_INSTANCE_REGISTRY() {
    return optional("MCP_INSTANCE_REGISTRY");
  },
  get MCP_DEFAULT_INSTANCE_SLUG() {
    return optional("MCP_DEFAULT_INSTANCE_SLUG");
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
  get MODEL_CHAT_DEFAULT() {
    return optional("MODEL_CHAT_DEFAULT") ?? "qwen/qwen3-32b";
  },
  get MODEL_CHAT_FAST() {
    return optional("MODEL_CHAT_FAST") ?? "google/gemma-4-12b-it";
  },
  get MODEL_CHAT_STANDARD() {
    return optional("MODEL_CHAT_STANDARD") ?? "meta-llama/llama-4-scout";
  },
  get MODEL_CHAT_QUALITY() {
    return optional("MODEL_CHAT_QUALITY") ?? "google/gemini-2.5-flash";
  },
  get MODEL_CHAT_CONVERSATION() {
    return optional("MODEL_CHAT_CONVERSATION") ?? "google/gemini-2.5-flash";
  },
  get MODEL_EMBEDDING_DEFAULT() {
    return optional("MODEL_EMBEDDING_DEFAULT") ?? "google/gemini-embedding-001";
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
