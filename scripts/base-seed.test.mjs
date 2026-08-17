import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalWorkspaceSeedSources,
  assertE2EValidationIdentityDefaults,
  assertE2EValidationIdentitySources,
  discoverProductionSeedPaths,
  selectRuntimeSeedPaths,
} from "./check-seed-fixtures.mjs";
import { selectSafeE2EValidationUser } from "./seed-e2e.mjs";

const source = readFileSync(new URL("../prisma/seed.mjs", import.meta.url), "utf8");
const e2eSource = readFileSync(new URL("./seed-e2e.mjs", import.meta.url), "utf8");

describe("production bootstrap seed", () => {
  it("establishes the workspace baseline through one short canonical transaction", () => {
    expect(source).toContain("ensureCanonicalWorkspace,");
    expect(source).toContain('from "../packages/domain/src/workspaces.ts"');
    expect(source).toContain("prisma.$transaction((tx) => ensureCanonicalWorkspace(tx,");
    expect(source).not.toMatch(/\b[A-Za-z_$][\w$]*\.workspace\.(?:create|upsert)\s*\(/);
  });

  it("does not reuse or reset the human administrator password for the system actor", () => {
    expect(source).not.toContain("systemEmail");
    expect(source).not.toContain("existingSystemUser");
    expect(source).not.toMatch(/approvalPolicy\.upsert\s*\(/);
  });

  it("discovers every runtime-eligible script deterministically and rejects arbitrary direct workspace writes", () => {
    const paths = discoverProductionSeedPaths();
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("prisma/seed.mjs");
    expect(paths).toContain("scripts/lib/client-stable-seed.mjs");
    expect(selectRuntimeSeedPaths([
      "scripts/bootstrap-client.mjs",
      "scripts/bootstrap-client.test.mjs",
      "notes/bootstrap-client.mjs",
    ])).toEqual(["scripts/bootstrap-client.mjs"]);

    expect(() => assertCanonicalWorkspaceSeedSources([{
      relativePath: "scripts/bootstrap-client.mjs",
      source: "await prisma.workspace.create({ data: {} });",
    }])).toThrow("scripts/bootstrap-client.mjs contains a direct workspace create/upsert");
  });

  it("keeps every local UI smoke on one non-reserved human validation identity", () => {
    expect(() => assertE2EValidationIdentityDefaults()).not.toThrow();
    expect(() => assertE2EValidationIdentitySources([{
      relativePath: "scripts/seed-e2e.mjs",
      source: 'AGENT_E2E_EMAIL="system+corgtex@corgtex.local"',
    }])).toThrow("retains the reserved canonical system actor");
  });

  it("fails the E2E seed preflight before writes for reserved or existing system identities", () => {
    expect(() => selectSafeE2EValidationUser("system+workspace@corgtex.local", [])).toThrow(
      "reserved canonical system identity namespace",
    );
    expect(() => selectSafeE2EValidationUser("validation@example.com", [{
      id: "user-1",
      memberships: [{ kind: "SYSTEM" }],
    }])).toThrow("protected system member");
    expect(selectSafeE2EValidationUser("validation@example.com", [{
      id: "user-1",
      email: "VALIDATION@EXAMPLE.COM",
      memberships: [{ kind: "HUMAN" }],
    }])).toMatchObject({ id: "user-1", email: "VALIDATION@EXAMPLE.COM" });

    const preflight = e2eSource.indexOf("const existingUser = selectSafeE2EValidationUser(email, matchingUsers)");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(e2eSource.indexOf("prisma.user.update"));
    expect(preflight).toBeLessThan(e2eSource.indexOf("prisma.user.create"));
    expect(preflight).toBeLessThan(e2eSource.indexOf("prisma.member.upsert"));
    expect(e2eSource).toContain('kind: "HUMAN"');
    expect(e2eSource).not.toContain('kind: "SYSTEM"');
    expect(e2eSource).toMatch(/prisma\.user\.update\([\s\S]*?data:\s*{\s*email,/);
  });
});
