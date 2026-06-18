import { describe, expect, it } from "vitest";

import { ALL_SCOPES } from "../agent-auth";
import {
  getModuleForScope,
  listModuleOwnedScopes,
  listModuleScopeOwnership,
  MODULE_MANIFESTS,
  PLATFORM_SCOPES,
} from "./registry";

/**
 * C1 parity / drift fence: the Module Manifest registry is the source of truth
 * for which module owns each MCP scope. The owning module's `scopes` plus the
 * cross-cutting `PLATFORM_SCOPES` must partition `ALL_SCOPES` (the canonical MCP
 * scope registry in agent-auth) exactly - so a scope cannot ship without an
 * owner, and ownership cannot drift from the scopes the MCP actually enforces.
 */
describe("module scope ownership — manifest <-> MCP scope registry parity", () => {
  it("assigns every owned scope to exactly one module", () => {
    // listModuleScopeOwnership throws if a scope is double-claimed.
    const ownership = listModuleScopeOwnership();
    const owned = listModuleOwnedScopes();
    expect(owned.length).toBe(ownership.size);
  });

  it("module-owned scopes and platform scopes are disjoint", () => {
    const owned = new Set(listModuleOwnedScopes());
    const overlap = PLATFORM_SCOPES.filter((scope) => owned.has(scope));
    expect(overlap).toEqual([]);
  });

  it("module-owned scopes ∪ platform scopes equals ALL_SCOPES exactly", () => {
    const partition = new Set<string>([...listModuleOwnedScopes(), ...PLATFORM_SCOPES]);
    const all = new Set<string>(ALL_SCOPES);

    const missingOwner = [...all].filter((scope) => !partition.has(scope)).sort();
    const unknownScope = [...partition].filter((scope) => !all.has(scope)).sort();

    expect(missingOwner).toEqual([]);
    expect(unknownScope).toEqual([]);
    expect(partition.size).toBe(all.size);
  });

  it("attributes representative scopes to the expected owning module", () => {
    expect(getModuleForScope("finance:read")).toBe("finance");
    expect(getModuleForScope("goals:write")).toBe("goals");
    expect(getModuleForScope("relationships:write")).toBe("relationships");
    expect(getModuleForScope("context-graph:approve")).toBe("context-maps");
    expect(getModuleForScope("runtime:write")).toBe("agent-governance");
    // Platform scopes are intentionally unowned by any single module.
    expect(getModuleForScope("workspace:read")).toBeUndefined();
    expect(getModuleForScope("conversations:write")).toBeUndefined();
  });

  it("every satellite contract requiredScope is a known MCP scope", () => {
    const known = new Set<string>(ALL_SCOPES);
    for (const mod of MODULE_MANIFESTS) {
      for (const capability of mod.contract ?? []) {
        for (const scope of capability.requiredScopes ?? []) {
          expect(known.has(scope), `${mod.key}.${capability.key} requires unknown scope "${scope}"`).toBe(true);
        }
      }
    }
  });
});
