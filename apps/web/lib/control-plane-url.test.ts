import { afterEach, describe, expect, it, vi } from "vitest";

describe("control-plane URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps local development links relative when no Ops URL is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    vi.stubEnv("CONTROL_PLANE_URL", "");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const { getControlPlaneHref } = await import("./control-plane-url");

    expect(getControlPlaneHref("/control-plane", "en")).toBe("/control-plane");
  });

  it("defaults production non-Ops deployments to ops.corgtex.com", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    vi.stubEnv("CONTROL_PLANE_URL", "");
    const { getControlPlaneHref } = await import("./control-plane-url");

    expect(getControlPlaneHref("/control-plane", "en")).toBe("https://ops.corgtex.com/control-plane");
  });

  it("uses CONTROL_PLANE_URL for canonical localized Ops links", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    vi.stubEnv("CONTROL_PLANE_URL", "https://ops.corgtex.com/");
    const { getControlPlaneHref } = await import("./control-plane-url");

    expect(getControlPlaneHref("/control-plane", "es")).toBe("https://ops.corgtex.com/es/control-plane");
  });

  it("keeps links relative inside the dedicated control-plane deployment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.stubEnv("APP_URL", "https://ops.corgtex.com");
    const { getCanonicalControlPlaneHref, getControlPlaneHref } = await import("./control-plane-url");

    expect(getControlPlaneHref("/control-plane/deployments/customer-1", "en")).toBe("/control-plane/deployments/customer-1");
    expect(getCanonicalControlPlaneHref("/control-plane/deployments/customer-1", "en")).toBe(
      "https://ops.corgtex.com/control-plane/deployments/customer-1",
    );
  });
});
