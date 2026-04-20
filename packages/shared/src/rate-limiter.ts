/**
 * In-memory sliding-window rate limiter.
 *
 * Each bucket is keyed by a string (e.g. `workspace:${id}:api` or
 * `workspace:${id}:agent`). Supports configurable window and max
 * requests per window.
 *
 * For multi-process deployments, swap this with a Redis-backed
 * implementation using the same interface.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAtMs: number;
};

type Bucket = {
  timestamps: number[];
  windowMs: number;
  limit: number;
};

const buckets = new Map<string, Bucket>();

function pruneExpired(bucket: Bucket, now: number) {
  const cutoff = now - bucket.windowMs;
  const firstValid = bucket.timestamps.findIndex((t) => t > cutoff);
  if (firstValid === -1) {
    bucket.timestamps = [];
  } else if (firstValid > 0) {
    bucket.timestamps = bucket.timestamps.slice(firstValid);
  }
}

export function checkRateLimit(key: string, opts: {
  windowMs: number;
  limit: number;
}): RateLimitResult {
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
  AUTH_PER_IP: { windowMs: 60_000, limit: 20 },
  /** Password reset requests per email per hour */
  PASSWORD_RESET_PER_EMAIL: { windowMs: 3_600_000, limit: 3 },
  /** Password reset requests per IP per hour */
  PASSWORD_RESET_PER_IP: { windowMs: 3_600_000, limit: 10 },
} as const;
