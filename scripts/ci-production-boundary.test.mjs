import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../.github/workflows/auto-revert.yml", import.meta.url), "utf8");

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Missing CI job ${name}`);
  return match[1];
}

describe("automatic production CI boundary", () => {
  it("verifies bundled migrations after the exact-release wait without bootstrap or ingestion writes", () => {
    const smoke = job("smoke-prod");
    expect(smoke).toContain('import { verifyMigrations } from "./scripts/start-web.mjs"; await verifyMigrations();');
    const releaseWait = smoke.indexOf("node scripts/railway-smoke.mjs");
    for (const check of ["await verifyMigrations()", "node scripts/check-migration-health.mjs"]) {
      expect(smoke.indexOf(check)).toBeGreaterThan(releaseWait);
      expect(smoke.indexOf(check)).toBeLessThan(smoke.indexOf("id: smoke-proof"));
    }
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
    expect(smoke).toContain('node scripts/production-validation-context.mjs --classify-app-release --output="$GITHUB_OUTPUT"');
    expect(smoke).toContain("id: smoke-proof");
    expect(job("observe-prod")).toContain("- smoke-prod");
    expect(job("observe-prod")).toContain("post-deploy-observation-gate.mjs");
  });

  it("shares the classifier and full push-range evidence across CI, recovery and production validation", () => {
    const smoke = job("smoke-prod");
    const classify = 'node scripts/production-validation-context.mjs --classify-app-release --output="$GITHUB_OUTPUT"';
    expect(smoke).toContain(classify);
    expect(smoke).toContain("RELEASE_CONTEXT_BEFORE: ${{ github.event.before }}");
    expect(smoke).toContain("RELEASE_CONTEXT_AFTER: ${{ github.sha }}");
    expect(smoke).toContain("name: production-app-release-context");
    expect(recovery).toContain(classify);
    expect(recovery).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(recovery).toContain("PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: .artifacts/ci-release-context/release-context.json");
    expect(recovery).toContain("RELEASE_CONTEXT_AFTER: ${{ steps.merge.outputs.sha }}");
    for (const consumer of [smoke, recovery]) {
      expect(consumer).not.toContain('case "$path"');
      expect(consumer).not.toContain("git diff --name-only");
      expect(consumer).not.toContain("git rev-parse \"${SHA}^1\"");
    }
    const validation = readFileSync(new URL("../.github/workflows/production-validation.yml", import.meta.url), "utf8");
    expect(validation).toContain("PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: .artifacts/ci-release-context/release-context.json");
    expect(validation).toContain('node scripts/production-validation-context.mjs --output="$GITHUB_OUTPUT"');
  });

  it("keeps recovery health, authentication, database, schema and exact-version conditions", () => {
    expect(recovery).toContain("REQUIRES_APP_RELEASE: ${{ steps.app-release.outputs.requires_app_release }}");
    expect(recovery).toContain('const requiresAppRelease = process.argv[3] !== "false";');
    expect(recovery).toContain("!requiresAppRelease || releaseGitSha === sha || releaseImageTag === sha");
    for (const condition of ['json?.status === "ok"', 'json?.service === "web"', 'json?.database === "up"',
      'json?.schema === "ready"', 'json?.app === "corgtex"', 'json?.auth === "password-session"']) {
      expect(recovery).toContain(condition);
    }
    expect(recovery).toContain("process.exit(healthOk && releaseMatches ? 0 : 1)");
    expect(job("check")).toContain("npx vitest run --project unit --project integration");
    const config = readFileSync(new URL("../vitest.config.mts", import.meta.url), "utf8");
    expect(config).toContain('"scripts/**/*.test.mjs"');
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
