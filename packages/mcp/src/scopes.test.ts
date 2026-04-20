import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_SCOPES, DEFAULT_SCOPES, SCOPE_REGISTRY } from "@corgtex/domain";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The drift-fence test: every `requireScope(..., "<scope>")` literal in the
 * MCP server source must reference a scope declared in SCOPE_REGISTRY.
 *
 * This is the safety net we wish we had had when `finance:read`/`finance:write`
 * shipped — they were enforced server-side but missing from the registry,
 * which meant the UI's "Connect" button issued credentials without those
 * scopes and Claude broke silently mid-conversation.
 */
describe("MCP scope registry — drift fence", () => {
  const serverSource = readFileSync(join(__dirname, "server.ts"), "utf8");

  // Match every `requireScope(<anything>, "<scope>")` call. The scope
  // literal must be a plain double-quoted string for this to match —
  // anything dynamic should be considered a bug and fail review.
  const requireScopePattern = /requireScope\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*"([^"]+)"\s*\)/g;

  const usedScopes = new Set<string>();
  for (const match of serverSource.matchAll(requireScopePattern)) {
    usedScopes.add(match[1]);
  }

  it("finds at least one requireScope call (sanity check)", () => {
    expect(usedScopes.size).toBeGreaterThan(0);
  });

  it("every scope used by an MCP tool exists in SCOPE_REGISTRY", () => {
    const undeclared = [...usedScopes].filter((scope) => !(scope in SCOPE_REGISTRY));
    expect(undeclared, `Undeclared scopes used in server.ts. Add them to SCOPE_REGISTRY in packages/domain/src/agent-auth.ts.`).toEqual([]);
  });

  it("every scope in DEFAULT_SCOPES exists in SCOPE_REGISTRY", () => {
    const orphaned = DEFAULT_SCOPES.filter((scope) => !(scope in SCOPE_REGISTRY));
    expect(orphaned).toEqual([]);
  });

  it("ALL_SCOPES matches the registry keys exactly", () => {
    expect([...ALL_SCOPES].sort()).toEqual(Object.keys(SCOPE_REGISTRY).sort());
  });
});
