import { env } from "./env";
import { getRedisClient, isRedisConfigured, redisKey } from "./redis";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAtMs: number;
};

export type RateLimitOptions = {
  windowMs: number;
  limit: number;
  failClosed?: boolean;
};

type Bucket = {
  timestamps: number[];
  windowMs: number;
  limit: number;
};

const buckets = new Map<string, Bucket>();

const REDIS_RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + window
if oldest[2] then
  resetAt = tonumber(oldest[2]) + window
end

if count >= limit then
  return {0, 0, resetAt}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1, resetAt}
`;

function pruneExpired(bucket: Bucket, now: number) {
  const cutoff = now - bucket.windowMs;
  const firstValid = bucket.timestamps.findIndex((t) => t > cutoff);
  if (firstValid === -1) {
    bucket.timestamps = [];
  } else if (firstValid > 0) {
    bucket.timestamps = bucket.timestamps.slice(firstValid);
  }
}

function checkInMemoryRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { timestamps: [], windowMs: opts.windowMs, limit: opts.limit };
    buckets.set(key, bucket);
  }

  // Update config if changed
  bucket.windowMs = opts.windowMs;
  bucket.limit = opts.limit;

  pruneExpired(bucket, now);

  const remaining = Math.max(0, bucket.limit - bucket.timestamps.length);
  const resetAtMs = bucket.timestamps.length > 0
    ? bucket.timestamps[0] + bucket.windowMs
    : now + bucket.windowMs;

  if (bucket.timestamps.length >= bucket.limit) {
    return { allowed: false, remaining: 0, limit: bucket.limit, resetAtMs };
  }

  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: remaining - 1,
    limit: bucket.limit,
    resetAtMs,
  };
}

function asRedisResult(value: unknown, limit: number): RateLimitResult | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }

  const allowed = Number(value[0]) === 1;
  const remaining = Math.max(0, Number(value[1]) || 0);
  const resetAtMs = Number(value[2]) || Date.now();

  return {
    allowed,
    remaining,
    limit,
    resetAtMs,
  };
}

async function checkRedisRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult | null> {
  const client = await getRedisClient();
  if (!client) {
    return null;
  }

  const now = Date.now();
  const result = await client.eval(REDIS_RATE_LIMIT_SCRIPT, {
    keys: [redisKey(`rate-limit:${key}`)],
    arguments: [
      String(now),
      String(opts.windowMs),
      String(opts.limit),
      `${now}:${Math.random().toString(36).slice(2)}`,
    ],
  });

  return asRedisResult(result, opts.limit);
}

function shouldFailClosed(opts: RateLimitOptions) {
  return Boolean(opts.failClosed && env.NODE_ENV === "production" && isRedisConfigured());
}

export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  try {
    const redisResult = await checkRedisRateLimit(key, opts);
    if (redisResult) {
      return redisResult;
    }
  } catch {
    if (shouldFailClosed(opts)) {
      return {
        allowed: false,
        remaining: 0,
        limit: opts.limit,
        resetAtMs: Date.now() + opts.windowMs,
      };
    }
  }

  if (shouldFailClosed(opts)) {
    return {
      allowed: false,
      remaining: 0,
      limit: opts.limit,
      resetAtMs: Date.now() + opts.windowMs,
    };
  }

  return checkInMemoryRateLimit(key, opts);
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

export function resetAllRateLimits() {
  buckets.clear();
}

// Pre-defined rate limit tiers
export const RATE_LIMITS = {
  /** API requests per workspace per minute */
  API_PER_WORKSPACE: { windowMs: 60_000, limit: 120 },
  /** Agent runs per workspace per minute */
  AGENT_PER_WORKSPACE: { windowMs: 60_000, limit: 10 },
  /** Inbound webhooks per workspace per minute */
  WEBHOOK_INGEST_PER_WORKSPACE: { windowMs: 60_000, limit: 30 },
  /** Auth attempts per IP per minute */
  AUTH_PER_IP: { windowMs: 60_000, limit: 20, failClosed: true },
  /** Password reset requests per email per hour */
  PASSWORD_RESET_PER_EMAIL: { windowMs: 3_600_000, limit: 3, failClosed: true },
  /** Password reset requests per IP per hour */
  PASSWORD_RESET_PER_IP: { windowMs: 3_600_000, limit: 10, failClosed: true },
  /** Self-serve procurement workspace creations per IP per hour */
  PROCUREMENT_SETUP_PER_IP: { windowMs: 3_600_000, limit: 10, failClosed: true },
  /** Self-serve procurement workspace creations per admin email per day */
  PROCUREMENT_SETUP_PER_EMAIL: { windowMs: 86_400_000, limit: 3, failClosed: true },
  /** Self-serve procurement workspace creations per company/domain per day */
  PROCUREMENT_SETUP_PER_COMPANY: { windowMs: 86_400_000, limit: 5, failClosed: true },
  /** Initial self-serve setup member invitation writes per setup session per hour */
  PROCUREMENT_SETUP_INVITES_PER_SESSION: { windowMs: 3_600_000, limit: 20, failClosed: true },
} as const;
