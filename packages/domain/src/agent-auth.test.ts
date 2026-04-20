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
