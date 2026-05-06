import { describe, expect, it } from "vitest";
import { controlPlaneLocaleCookie, localizedControlPlanePath, normalizeControlPlaneLocale } from "./locale-path";

describe("localizedControlPlanePath", () => {
  it("uses the unprefixed default-locale path for English", () => {
    expect(localizedControlPlanePath("/control-plane", "en")).toBe("/control-plane");
    expect(localizedControlPlanePath("/control-plane/deployments/customer-1", "en")).toBe(
      "/control-plane/deployments/customer-1",
    );
  });

  it("adds the Spanish prefix while preserving nested control plane paths", () => {
    expect(localizedControlPlanePath("/control-plane", "es")).toBe("/es/control-plane");
    expect(localizedControlPlanePath("/control-plane/deployments/customer-1", "es")).toBe(
      "/es/control-plane/deployments/customer-1",
    );
  });

  it("normalizes paths that already include a locale prefix", () => {
    expect(localizedControlPlanePath("/es/control-plane", "en")).toBe("/control-plane");
    expect(localizedControlPlanePath("/en/control-plane/deployments/customer-1", "es")).toBe(
      "/es/control-plane/deployments/customer-1",
    );
  });
});

describe("controlPlaneLocaleCookie", () => {
  it("persists the next-intl locale cookie for client-side switches", () => {
    expect(controlPlaneLocaleCookie("en")).toBe("NEXT_LOCALE=en; path=/; max-age=31536000; SameSite=Lax");
    expect(controlPlaneLocaleCookie("es")).toBe("NEXT_LOCALE=es; path=/; max-age=31536000; SameSite=Lax");
  });
});

describe("normalizeControlPlaneLocale", () => {
  it("falls back to English for unsupported or missing locales", () => {
    expect(normalizeControlPlaneLocale("es")).toBe("es");
    expect(normalizeControlPlaneLocale("en")).toBe("en");
    expect(normalizeControlPlaneLocale("fr")).toBe("en");
    expect(normalizeControlPlaneLocale(undefined)).toBe("en");
  });
});
