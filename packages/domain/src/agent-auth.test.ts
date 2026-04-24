import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("resolveAgentActorFromBearer", () => {
  it("resolves the bootstrap agent with scoped workspaces", async () => {
    restoreEnv();
    Object.assign(process.env, {
      AGENT_API_KEY: "bootstrap-secret",
      AGENT_ALLOWED_WORKSPACE_IDS: "ws-1,ws-2",
    });

    const { resolveAgentActorFromBearer } = await import("./agent-auth");
    const actor = await resolveAgentActorFromBearer("agent-bootstrap-secret");

    expect(actor).toEqual({
      kind: "agent",
      authProvider: "bootstrap",
      label: "bootstrap-agent",
      workspaceIds: ["ws-1", "ws-2"],
    });
  });

  it("returns null for unknown bearer tokens", async () => {
    restoreEnv();
    Object.assign(process.env, {
      AGENT_API_KEY: "bootstrap-secret",
    });

    const { resolveAgentActorFromBearer } = await import("./agent-auth");

    await expect(resolveAgentActorFromBearer("agent-wrong-secret")).resolves.toBeNull();
    await expect(resolveAgentActorFromBearer("bearer-something-else")).resolves.toBeNull();
  });
});

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      agentCredential: { findUnique: vi.fn(), update: vi.fn() },
      agentIdentity: { findFirst: vi.fn(), create: vi.fn() },
    },
  };
});

describe("credentialAgentAuthProvider", () => {
  it("resolves external agent identity from credential", async () => {
    const { prisma } = await import("@corgtex/shared");
    const { credentialAgentAuthProvider } = await import("./agent-auth");

    vi.mocked(prisma.agentCredential.findUnique).mockResolvedValue({
      id: "cred-1",
      workspaceId: "ws-1",
      label: "My Agent",
      scopes: ["read"],
      isActive: true,
    } as any);

    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({
      id: "identity-1",
    } as any);

    const actor = await credentialAgentAuthProvider.resolve("agentc-some-token");

    expect(actor).toEqual({
      kind: "agent",
      authProvider: "credential",
      credentialId: "cred-1",
      label: "My Agent",
      workspaceIds: ["ws-1"],
      scopes: ["read"],
      agentIdentityId: "identity-1",
    });
  });
});
