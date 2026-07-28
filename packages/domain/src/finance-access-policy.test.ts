import { describe, expect, it } from "vitest";

import { getModuleByKey, rolesWithDefaultAccess } from "./modules";

describe("finance access policy (manifest-derived)", () => {
  it("keeps reserved write access scoped to finance stewards and admins", () => {
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
