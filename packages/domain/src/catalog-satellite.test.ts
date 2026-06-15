import { describe, expect, it } from "vitest";

import { getSatelliteModuleByAppKey } from "./modules";

/**
 * The catalog's `marketplaceAppSources` derives the Practice Ledger app's
 * structured identity and capability contract from the Module Manifest
 * registry. This test pins that registry-sourced data so the catalog output
 * stays behavior-preserving after the de-hardcoding.
 */
describe("catalog satellite source (registry-derived)", () => {
  it("exposes the Practice Ledger structured identity", () => {
    const ledger = getSatelliteModuleByAppKey("practice-ledger");
    expect(ledger?.title).toBe("Practice Ledger");
    expect(ledger?.satellite).toMatchObject({
      appKey: "practice-ledger",
      repository: "github.com/Corgtexdotcom/practice-ledger",
      appUrlEnv: "PRACTICE_LEDGER_APP_URL",
      mcpUrlEnv: "PRACTICE_LEDGER_MCP_URL",
      appCategory: "FINANCE",
      routingCategory: "FINANCE",
      dataClassification: "CLIENT_PRIVATE",
    });
  });

  it("exposes the four capability contract keys with scopes", () => {
    const ledger = getSatelliteModuleByAppKey("practice-ledger");
    const capabilities = ledger?.contract ?? [];
    expect(capabilities.map((capability) => capability.key)).toEqual([
      "expenses.create_draft",
      "time_entries.create_draft",
      "budgets.read_status",
      "knowledge.sync_summary",
    ]);
    for (const capability of capabilities) {
      expect(Array.isArray(capability.requiredScopes)).toBe(true);
      expect((capability.requiredScopes ?? []).length).toBeGreaterThan(0);
    }
  });
});
