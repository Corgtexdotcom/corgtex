import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ edge: vi.fn(), node: vi.fn(), sentry: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: mocks.sentry, init: vi.fn() }));
vi.mock("@corgtex/shared/telemetry", () => ({ captureErrorTelemetry: mocks.edge }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: mocks.node }));
import { authorizationContextTelemetryAttributes, onRequestError } from "./instrumentation";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("instrumentation runtime boundary", () => {
  it.each(["edge", "nodejs"])("uses only the %s telemetry adapter", async runtime => {
    vi.stubEnv("NEXT_RUNTIME", runtime);
    await onRequestError(new Error("synthetic"), { method: "POST" }, { routeType: "action" });
    expect(runtime === "edge" ? mocks.edge : mocks.node).toHaveBeenCalledWith(expect.objectContaining({ surface: "server_action" }));
    expect(runtime === "edge" ? mocks.node : mocks.edge).not.toHaveBeenCalled();
  });

  it("captures bounded middleware metadata only for missing authorization context", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("CONTAINER_APP_REVISION", "ca-corgtex-ss-prod-web--revision1");
    vi.stubEnv("CONTAINER_APP_REPLICA_NAME", "ca-corgtex-ss-prod-web--revision1-abc123-xyz89");
    const error = Object.assign(new Error("context unavailable"), { code: "AUTHORIZATION_CONTEXT_REQUIRED" });

    await onRequestError(error, {
      path: "/en?private=must-not-appear",
      method: "GET",
      headers: {
        RSC: "private-value",
        "Next-Action": "private-action",
        "X-Middleware-Subrequest": "private-chain",
      },
    }, { routePath: "/[locale]", routeType: "render", routerKind: "App Router" });

    expect(mocks.node).toHaveBeenCalledWith(expect.objectContaining({
      attributes: expect.objectContaining({
        container_app_replica_name: "ca-corgtex-ss-prod-web--revision1-abc123-xyz89",
        container_app_revision: "ca-corgtex-ss-prod-web--revision1",
        request_middleware_subrequest_header_present: true,
        request_next_action_header_present: true,
        request_path_category: "known_locale",
        request_rsc_header_present: true,
      }),
    }));
    const captured = JSON.stringify(mocks.node.mock.calls[0]?.[0]);
    expect(captured).not.toContain("private=must-not-appear");
    expect(captured).not.toContain("private-value");
    expect(captured).not.toContain("private-action");
    expect(captured).not.toContain("private-chain");
  });

  it("does not fall back to a raw path or URL when the route template is unavailable", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = Object.assign(new Error("context unavailable"), { code: "AUTHORIZATION_CONTEXT_REQUIRED" });

    await onRequestError(error, {
      path: "/en/workspaces/private-workspace?private=query",
      url: "https://app.example/en/workspaces/private-workspace?private=query",
      method: "GET",
    }, { routeType: "render" });

    const captured = mocks.node.mock.calls[0]?.[0];
    expect(captured.route).toBeUndefined();
    expect(captured.attributes).toEqual(expect.objectContaining({
      request_path_category: "other",
      request_rsc_header_present: "unknown",
    }));
    expect(JSON.stringify(captured)).not.toContain("private-workspace");
    expect(JSON.stringify(captured)).not.toContain("private=query");
    expect(JSON.stringify(captured)).not.toContain("https://app.example");
  });

  it("uses unknown when headers are unavailable and rejects unbounded platform identifiers", () => {
    const attributes = authorizationContextTelemetryAttributes({
      path: "/en/workspaces/customer-id?private=query",
    }, {
      CONTAINER_APP_REVISION: `revision-${"x".repeat(201)}`,
      CONTAINER_APP_REPLICA_NAME: "replica/invalid",
      NODE_ENV: "test",
    });

    expect(attributes).toEqual({
      container_app_replica_name: undefined,
      container_app_revision: undefined,
      request_middleware_subrequest_header_present: "unknown",
      request_next_action_header_present: "unknown",
      request_path_category: "other",
      request_rsc_header_present: "unknown",
    });
    expect(JSON.stringify(attributes)).not.toContain("customer-id");
    expect(JSON.stringify(attributes)).not.toContain("private=query");
  });

  it("records false only when an available header collection lacks the headers", () => {
    expect(authorizationContextTelemetryAttributes({ path: "/", headers: {} }, { NODE_ENV: "test" })).toEqual(expect.objectContaining({
      request_middleware_subrequest_header_present: false,
      request_next_action_header_present: false,
      request_path_category: "root",
      request_rsc_header_present: false,
    }));
  });

  it("does not attach request diagnostics to unrelated errors", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await onRequestError(new Error("synthetic"), {
      path: "/en?private=must-not-appear",
      method: "GET",
      headers: { rsc: "1" },
    }, { routeType: "render" });

    const attributes = mocks.node.mock.calls[0]?.[0]?.attributes;
    expect(attributes).not.toHaveProperty("request_path_category");
    expect(JSON.stringify(attributes)).not.toContain("private=must-not-appear");
  });
});
