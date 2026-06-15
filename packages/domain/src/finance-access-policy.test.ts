import { describe, expect, it } from "vitest";

import { getModuleByKey, rolesWithDefaultAccess } from "./modules";

/**
 * A1 parity anchor: `requireFinanceAccess` now derives its allowed roles from
 * the finance module's manifest default policy instead of a hardcoded list.
 * This pins the derived roles to the prior hardcoded behavior
 * (`["FINANCE_STEWARD", "ADMIN"]`), proving zero behavior change.
 */
describe("finance access policy (manifest-derived)", () => {
  it("derives manage (write) roles identical to the prior hardcoded guard", () => {
    const financeModule = getModuleByKey("finance");
    expect(financeModule).toBeTruthy();
    expect(rolesWithDefaultAccess(financeModule!, "write")).toEqual(["FINANCE_STEWARD", "ADMIN"]);
  });

  it("exposes read access to every member role (tab visibility unchanged)", () => {
    const financeModule = getModuleByKey("finance");
    expect(rolesWithDefaultAccess(financeModule!, "read")).toEqual([
      "CONTRIBUTOR",
      "FACILITATOR",
      "FINANCE_STEWARD",
      "ADMIN",
    ]);
  });
});
