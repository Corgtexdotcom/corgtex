import { AgentConnectionManager } from "../settings/AgentConnectionManager";
import { AgentModelOverride } from "./AgentModelOverride";
import { listAgentCredentials, listAgentConfigs, DEFAULT_SCOPES, SCOPE_REGISTRY } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";

export async function AccessControlTab({
  workspaceId,
  actor,
  mcpUrl,
}: {
  workspaceId: string;
  actor: AppActor;
  mcpUrl: string;
}) {
  const [credentials, agents] = await Promise.all([
    listAgentCredentials(actor, workspaceId),
    listAgentConfigs(actor, workspaceId),
  ]);

  return (
    <div className="stack" style={{ gap: 40 }}>
      <section>
        <h2 className="nr-section-header">Agent Model Overrides</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Override the default model used for each agent based on your cost and quality preferences.
        </p>

        <div className="stack" style={{ gap: 16 }}>
          {agents.map(agent => (
            <div key={agent.agentKey} className="nr-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 600 }}>{agent.label}</div>
                <div className="nr-item-meta" style={{ fontSize: "0.85rem" }}>{agent.description}</div>
              </div>
              <AgentModelOverride workspaceId={workspaceId} agent={agent} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="nr-section-header">Agent credentials (MCP)</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Create credentials to connect external AI clients (like Claude or Cursor) to your workspace via the Model Context Protocol (MCP).
        </p>

        <AgentConnectionManager
          workspaceId={workspaceId}
          mcpUrl={mcpUrl}
          initialCredentials={credentials}
          defaultScopes={DEFAULT_SCOPES}
          scopeRegistry={SCOPE_REGISTRY}
        />
      </section>
    </div>
  );
}
