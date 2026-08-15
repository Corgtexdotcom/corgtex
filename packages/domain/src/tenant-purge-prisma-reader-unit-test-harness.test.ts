import { describe, expect, it } from "vitest";
import { tenantPurgePrismaReaderUnitHarness as harness } from
  "./tenant-purge-prisma-reader-unit-test-harness";
const SAFE_SOURCE = `export function createTenantPurgePrismaAuthorizeAndCapture(
  privateAuthority, targetMode, runId, redactionKeyBytes,
  pageSize, maxPagesPerModel, maxEvidenceItems, cacheMaxTtlSeconds
) { return privateAuthority && targetMode && runId && redactionKeyBytes &&
  pageSize && maxPagesPerModel && maxEvidenceItems && cacheMaxTtlSeconds; }`;
const registered = harness.register(async function selfTestRecorderOnly() { return async (scenario) => {
  scenario.expected.accesses.forEach((path) => scenario.access(path));
  if (scenario.expected.fired) scenario.fire(scenario.expected.fired);
  return Object.freeze({
    calls: scenario.expected.calls,
    outcome: scenario.expected.outcome,
    accesses: scenario.observed().accesses,
    fired: scenario.observed().fired,
  });
}; }, SAFE_SOURCE);
describe("tenant purge Prisma reader unit harness self-test", () => {
  it("keeps stable IDs complete and unique while registering every explicit variant", () => {
    const ids = harness.cases.map(([id]) => id);
    expect(ids).toHaveLength(114);
    expect(new Set(ids).size).toBe(ids.length);
    expect(registered).toHaveLength(137);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.filter((name) => name.startsWith("DENY-02 "))).toHaveLength(12);
    expect(registered.filter((name) => name.startsWith("TOPO-15 "))).toHaveLength(13);
  });
  it("creates isolated immutable fixtures and localizes strict access and injection failures", () => {
    const entry = harness.cases.find(([id]) => id === "REJECT-02");
    expect(entry).toBeDefined();
    const first = harness.makeScenario(entry!, null, SAFE_SOURCE);
    const second = harness.makeScenario(entry!, null, SAFE_SOURCE);
    expect(first.fixture).not.toBe(second.fixture);
    expect(Object.isFrozen(first.fixture)).toBe(true);
    expect(() => first.access("tenantPurgeRun.delete")).toThrow("unexpected access");
    first.fire("REJECT-02");
    expect(() => first.fire("REJECT-02")).toThrow("unexpected injection");
    const findUnique = () => null;
    const strict = harness.strict(Object.freeze({ tenantPurgeRun: Object.freeze({ findUnique }) }));
    const client = strict.value as { tenantPurgeRun: { findUnique: () => null } };
    expect(client.tenantPurgeRun.findUnique).toBe(findUnique);
    expect(strict.observed()).toEqual(["tenantPurgeRun", "tenantPurgeRun.findUnique"]);
    expect(() => (strict.value as { customerDeployment: unknown }).customerDeployment)
      .toThrow("unexpected access: customerDeployment");
  });
  it("rejects forbidden source specimens and a deliberately deficient negative probe", () => {
    const specimens = [
      "prisma.user.delete({})", "prisma.user.count({ include: true })", "prisma.$queryRaw`SELECT 1`",
      "lock retry log route provider schema migration", "index.ts export const extra = true",
      "function f(client, reader, request, revisionToken, rawAggregate) {}",
      "function f(object, array, Date, Uint8Array, Proxy) {}",
    ];
    specimens.forEach((source, index) => expect(harness.inspect(source)[index]).toBe(true));
    const scenario = harness.makeScenario(harness.cases[0], null, SAFE_SOURCE);
    const deficient = Object.freeze({ calls: [], outcome: "fabricated", accesses: [], fired: null });
    expect(() => harness.verify(scenario, deficient)).toThrow();
  });
});
