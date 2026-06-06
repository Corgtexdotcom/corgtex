import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutableIntercomEnv = {
  NEXT_PUBLIC_INTERCOM_APP_ID: string | undefined;
  NEXT_PUBLIC_INTERCOM_API_BASE: string;
  INTERCOM_MESSENGER_SECRET: string | undefined;
};

const {
  env,
  getWorkspaceFeatureFlags,
  onboardingFindUnique,
  requireWorkspaceMembership,
  resolveRequestActor,
  workspaceFindUnique,
} = vi.hoisted(() => {
  const env: MutableIntercomEnv = {
    NEXT_PUBLIC_INTERCOM_APP_ID: "intercom-app",
    NEXT_PUBLIC_INTERCOM_API_BASE: "https://api-iam.intercom.io",
    INTERCOM_MESSENGER_SECRET: "messenger-secret",
  };

  return {
    env,
    getWorkspaceFeatureFlags: vi.fn(),
    onboardingFindUnique: vi.fn(),
    requireWorkspaceMembership: vi.fn(),
    resolveRequestActor: vi.fn(),
    workspaceFindUnique: vi.fn(),
  };
});

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  requireWorkspaceMembership,
  SELF_SERVE_WORKSPACE_TOUR_KEY: "self_serve_workspace",
  SELF_SERVE_WORKSPACE_TOUR_VERSION: "v1",
}));

vi.mock("@corgtex/shared", () => ({
  env,
  isDatabaseUnavailableError: vi.fn(() => false),
  prisma: {
    userWorkspaceOnboardingState: {
      findUnique: onboardingFindUnique,
    },
    workspace: {
      findUnique: workspaceFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(workspaceId = "workspace-1") {
  return new NextRequest(`https://app.corgtex.com/api/workspaces/${workspaceId}/intercom-token?locale=es`);
}

function decodeJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    signature,
    signingInput: `${header}.${payload}`,
  };
}

describe("GET /api/workspaces/[workspaceId]/intercom-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.NEXT_PUBLIC_INTERCOM_APP_ID = "intercom-app";
    env.NEXT_PUBLIC_INTERCOM_API_BASE = "https://api-iam.intercom.io";
    env.INTERCOM_MESSENGER_SECRET = "messenger-secret";
    resolveRequestActor.mockResolvedValue({
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "Corgtex User",
        globalRole: "USER",
      },
    });
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    workspaceFindUnique.mockResolvedValue({
      id: "workspace-1",
      slug: "acme",
      name: "Acme",
      plan: "ENTERPRISE_MANAGED",
    });
    getWorkspaceFeatureFlags.mockResolvedValue({
      GOALS: true,
      AI_WORKSPACES: true,
      CONTEXT_MAPS: false,
    });
    onboardingFindUnique.mockResolvedValue({
      completedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
  });

  it("returns a clean auth error when the request has no session", async () => {
    resolveRequestActor.mockRejectedValueOnce(new MockAppError(401, "UNAUTHENTICATED", "Missing session."));
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing session.",
      },
    });
  });

  it("rejects actors without workspace membership", async () => {
    requireWorkspaceMembership.mockRejectedValueOnce(new MockAppError(403, "NOT_A_MEMBER", "Not a member."));
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_A_MEMBER",
        message: "Not a member.",
      },
    });
  });

  it("disables Intercom cleanly when required env is missing", async () => {
    env.INTERCOM_MESSENGER_SECRET = undefined;
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
    expect(workspaceFindUnique).not.toHaveBeenCalled();
  });

  it("rejects non-user actors", async () => {
    resolveRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "bootstrap",
      label: "Agent",
    });
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Only signed-in users can open Intercom support.",
      },
    });
    expect(requireWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("returns a signed JWT with only approved support metadata", async () => {
    const { GET } = await import("./route");

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(body).toMatchObject({
      enabled: true,
      appId: "intercom-app",
      apiBase: "https://api-iam.intercom.io",
      expiresAt: expect.any(String),
      intercomUserJwt: expect.any(String),
    });

    const decoded = decodeJwt(body.intercomUserJwt);
    const expectedSignature = createHmac("sha256", "messenger-secret")
      .update(decoded.signingInput)
      .digest("base64url");

    expect(decoded.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decoded.signature).toBe(expectedSignature);
    expect(decoded.payload).toMatchObject({
      user_id: "user-1",
      email: "user@example.com",
      name: "Corgtex User",
      language_override: "es",
      corgtex_surface: "web_app",
      corgtex_workspace_id: "workspace-1",
      corgtex_workspace_slug: "acme",
      corgtex_workspace_name: "Acme",
      corgtex_workspace_role: "ADMIN",
      corgtex_workspace_plan: "ENTERPRISE_MANAGED",
      corgtex_enabled_features: "AI_WORKSPACES,GOALS",
      corgtex_enabled_feature_count: 2,
      corgtex_onboarding_completed: true,
      company: {
        company_id: "workspace-1",
        name: "Acme",
        plan: "ENTERPRISE_MANAGED",
        workspace_slug: "acme",
      },
    });
    expect(decoded.payload.exp).toBeGreaterThan(decoded.payload.iat);
    expect(decoded.payload).not.toHaveProperty("documents");
    expect(decoded.payload).not.toHaveProperty("agentRuns");
    expect(decoded.payload).not.toHaveProperty("transcripts");
  });
});
