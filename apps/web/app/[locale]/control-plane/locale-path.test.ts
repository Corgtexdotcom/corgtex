import { describe, expect, it } from "vitest";
import { localizedControlPlanePath } from "./locale-path";

describe("localizedControlPlanePath", () => {
  it("uses an explicit English prefix so the locale cookie is updated", () => {
    expect(localizedControlPlanePath("/control-plane", "en")).toBe("/en/control-plane");
    expect(localizedControlPlanePath("/control-plane/customers/customer-1", "en")).toBe(
      "/en/control-plane/customers/customer-1",
    );
  });

  it("adds the Spanish prefix while preserving nested control plane paths", () => {
    expect(localizedControlPlanePath("/control-plane", "es")).toBe("/es/control-plane");
    expect(localizedControlPlanePath("/control-plane/customers/customer-1", "es")).toBe(
      "/es/control-plane/customers/customer-1",
    );
  });

  it("normalizes paths that already include a locale prefix", () => {
    expect(localizedControlPlanePath("/es/control-plane", "en")).toBe("/en/control-plane");
    expect(localizedControlPlanePath("/en/control-plane/customers/customer-1", "es")).toBe(
      "/es/control-plane/customers/customer-1",
    );
  });
});
