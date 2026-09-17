import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../../package.json"));
const workflow = parse(read("../../.github/workflows/core-continuity.yml"));
const config = JSON.parse(read("./tsconfig.shared-transfer.json"));
const job = workflow.jobs["core-continuity"];

describe("Core continuity checked entrypoints", () => {
  it("runs the database suite with the consumer-hold subcase enabled", () => {
    expect(pkg.scripts["test:migration:core-continuity"]).toBe(
      "CORE_CONTINUITY_CONSUMER_HOLD_READY=true tsx --test scripts/migration/core-crm-continuity.integration.test.ts",
    );
  });

  it("covers PRs, main pushes and merge queues without path or job exclusions", () => {
    expect(workflow.on).toEqual({
      pull_request: { branches: ["main"] },
      push: { branches: ["main"] },
      merge_group: null,
    });
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("migrates two loopback databases and runs the package command without external configuration", () => {
    for (const side of ["SOURCE", "TARGET"]) {
      const url = new URL(job.env["CORE_CONTINUITY_" + side + "_URL"]);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/continuity_" + side.toLowerCase() + "_test");
    }
    expect(job.services.postgres.ports).toEqual(["127.0.0.1:5432:5432", "127.0.0.2:5432:5432"]);
    expect(job.services.postgres.options).toContain("--cpus 1 --memory 1g --memory-swap 1g");
    const setup = job.steps.find(step => step.name === "Generate Prisma and migrate both synthetic databases");
    expect(setup.run).toContain("createdb -U postgres continuity_target_test");
    expect(setup.run).toContain("node node_modules/prisma/build/index.js generate");
    expect(setup.run).toContain('for database_url in "$CORE_CONTINUITY_SOURCE_URL" "$CORE_CONTINUITY_TARGET_URL" "$CORE_CONTINUITY_CLONE_URL"');
    expect(setup.run).toContain("node node_modules/prisma/build/index.js migrate deploy");
    const test = job.steps.find(step => step.name === "Test Core continuity including real consumer hold");
    expect(test.run).toContain("env -i");
    expect(test.run).toContain('DATABASE_URL="$database_url"');
    expect(test.run).toContain('u.searchParams.set("sslaccept", "strict")');
    expect(test.run).toContain('CORE_CONTINUITY_TLS_CA="$RUNNER_TEMP/core-continuity-tls/ca.crt"');
    expect(test.run).toContain('CORE_CONTINUITY_CLONE_URL="$CORE_CONTINUITY_CLONE_URL"');
    expect(test.run).toContain("CORE_CONTINUITY_CONSUMER_HOLD_READY=true");
    expect(test.run).toContain("npm run test:migration:core-continuity");
    expect(test.if).toBeUndefined();
    expect(test["continue-on-error"]).toBeUndefined();
    expect(test.run).not.toMatch(/secrets\.|\|\| true/);
  });

  it("requires real TLS targets, a distinct clone endpoint and ephemeral key cleanup", () => {
    const target = new URL(job.env.CORE_CONTINUITY_TARGET_URL);
    const clone = new URL(job.env.CORE_CONTINUITY_CLONE_URL);
    expect(clone.pathname).toBe(target.pathname);
    expect(clone.username).toBe(target.username);
    expect(clone.hostname).toBe("localhost");
    expect(clone.port).not.toBe(target.port);
    expect(job.services.clone.ports).toEqual(["127.0.0.1:5433:5432"]);
    expect(job.services.clone.options).toContain("--cpus 1 --memory 1g --memory-swap 1g");
    const setup = job.steps.find(step => step.name === "Configure ephemeral trusted TLS on both target endpoints");
    expect(setup.run).toContain("core-continuity-tls-fixture.sh");
    expect(setup.run).toContain('"${{ job.services.postgres.id }}" "${{ job.services.clone.id }}"');
    expect(setup.run).toContain("ALTER SYSTEM SET ssl=on");
    const cleanup = job.steps.find(step => step.name === "Remove ephemeral TLS keys");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toBe('rm -rf -- "$RUNNER_TEMP/core-continuity-tls"');
    const integration = read("./core-crm-continuity.integration.test.ts");
    expect(integration).not.toMatch(/\bskip\s*:/);
    expect(integration).toContain('assert.equal(process.env.CORE_CONTINUITY_CONSUMER_HOLD_READY, "true")');
    expect(integration).toContain("readFileSync(process.env.CORE_CONTINUITY_TLS_CA!)");
  });

  it("keeps the Core helper in the existing transfer typecheck", () => {
    expect(config.include).toContain("core-crm-continuity.ts");
    expect(pkg.scripts["test:tenant-transfer"]).toContain("tsc -p scripts/migration/tsconfig.shared-transfer.json --noEmit");
  });
});
