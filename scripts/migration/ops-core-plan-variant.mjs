import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";

/** Global plan versions are independent of the v1 source-health, journal and
 * receipt schemas. Source-only legacy v1 plans remain valid at source boundaries;
 * transfer/operator validation separately requires their complete target plan. */
export function opsCorePlanSharedStateVariant(plan) {
  const fail = () => { throw new Error("MIGRATION_PLAN_VARIANT_INVALID"); };
  if (!plan || ![1, 2].includes(plan.schemaVersion)) fail();
  if (plan.schemaVersion === 1) {
    if (Object.hasOwn(plan, "sharedState") || (plan.azure?.sharedStateBackend ?? "redis") !== "redis") fail();
    return "redis";
  }
  const state = plan.sharedState;
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Object.keys(state).sort().join(",") !== "backend,sourceRedis"
    || state.backend !== "postgres" || Object.hasOwn(plan, "redis")
    || plan.azure?.sharedStateBackend !== "postgres" || plan.azure.redis !== null
    || state.sourceRedis?.mode !== "standalone") fail();
  try { redisGateBindingSha256(state.sourceRedis); } catch { fail(); }
  return "postgres";
}
