import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUiRedirect } from "./control-plane-middleware";

function request(url: string, headers?: HeadersInit) {
  return new NextRequest(url, { headers });
}

describe("controlPlaneUiRedirect", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not intercept health checks", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.stubEnv("APP_URL", "https://ops.corgtex.com");

    expect(controlPlaneUiRedirect(request("https://web-production-6a3ab.up.railway.app/api/health"))).toBeNull();
  });

  it("redirects control-plane pages from non-Ops deployments to the canonical Ops host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    vi.stubEnv("CONTROL_PLANE_URL", "https://ops.corgtex.com");

    const response = controlPlaneUiRedirect(request("https://app.corgtex.com/control-plane#mcp"));

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("https://ops.corgtex.com/control-plane");
  });

  it("redirects raw Railway Ops browser pages to ops.corgtex.com", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.stubEnv("APP_URL", "https://ops.corgtex.com");

    const response = controlPlaneUiRedirect(
      request("https://web-production-6a3ab.up.railway.app/control-plane/deployments/dpl_1?tab=support"),
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("https://ops.corgtex.com/control-plane/deployments/dpl_1?tab=support");
  });

  it("permanently redirects stale customer detail links to deployment detail links", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.stubEnv("APP_URL", "https://ops.corgtex.com");

    const response = controlPlaneUiRedirect(
      request("https://ops.corgtex.com/es/control-plane/customers/dc2f835b-087a-47e8-917e-5f3ead5206bc"),
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://ops.corgtex.com/es/control-plane/deployments/dc2f835b-087a-47e8-917e-5f3ead5206bc",
    );
  });
});
