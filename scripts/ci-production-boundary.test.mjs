import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Missing CI job ${name}`);
  return match[1];
}

describe("automatic production CI boundary", () => {
  it("verifies bundled migrations after readiness without bootstrap or ingestion writes", () => {
    const smoke = job("smoke-prod");
    expect(smoke).toContain('import { verifyMigrations } from "./scripts/start-web.mjs"; await verifyMigrations();');
    expect(smoke.indexOf("await verifyMigrations()")).toBeGreaterThan(smoke.indexOf("--label backup-app"));
    expect(smoke).toContain("DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}");
    expect(smoke).not.toMatch(/release:db|release-db\.mjs|prisma\s+migrate\s+deploy|prisma\s+db\s+seed|npm run seed|migrate-and-seed|ingestion-guidance-smoke\.mjs|check:(?:migration|seed)-fixtures/);
    expect(smoke).not.toMatch(/run:.*(?:node scripts\/start-web\.mjs|\.main\(\))/);
  });

  it("retains authenticated smoke, exact-release proof and observation", () => {
    const smoke = job("smoke-prod");
    expect(smoke).toContain("- check\n      - db-sync\n      - build");
    expect(smoke).toContain("node scripts/check-migration-health.mjs");
    expect(smoke).toContain("node scripts/self-serve-production-readiness.mjs");
    expect(smoke).toContain("node scripts/railway-smoke.mjs https://app.corgtex.com ${{ secrets.ADMIN_EMAIL }} ${{ secrets.ADMIN_PASSWORD }}");
    expect(smoke).toContain("CORGTEX_SKIP_RELEASE_MATCH: ${{ steps.app-release.outputs.skip_release_match }}");
    expect(smoke).toContain("skip_release_match=false");
    expect(smoke).toContain("id: smoke-proof");
    expect(job("observe-prod")).toContain("- smoke-prod");
    expect(job("observe-prod")).toContain("post-deploy-observation-gate.mjs");
  });

  it("retains isolated PostgreSQL migration, integration and seed-fixture checks", () => {
    for (const name of ["check", "db-sync"]) {
      expect(job(name)).toContain("image: pgvector/pgvector:pg16");
      expect(job(name)).toContain("@localhost:5432/");
      expect(job(name)).toContain("npx prisma migrate deploy");
      expect(job(name)).not.toContain("secrets.PRODUCTION_DATABASE_URL");
    }
    expect(job("check")).toContain("npx vitest run --project unit --project integration");
    expect(job("db-sync")).toContain("npm run check:migration-fixtures");
    expect(job("db-sync")).toContain("npm run check:seed-fixtures");
  });
});
