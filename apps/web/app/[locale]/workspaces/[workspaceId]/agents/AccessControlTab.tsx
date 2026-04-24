import { AgentConnectionManager } from "../settings/AgentConnectionManager";
import { AgentModelOverride } from "./AgentModelOverride";
import { listAgentCredentials, listAgentConfigs, DEFAULT_SCOPES, SCOPE_REGISTRY } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
import { getTranslations } from "next-intl/server";

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
  const t = await getTranslations("agents");

  return (
    <div className="stack" style={{ gap: 40 }}>
      <section>
        <h2 className="nr-section-header">{t("overridesTitle")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          {t("overridesDesc")}
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
        <h2 className="nr-section-header">{t("credentialsTitle")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          {t("credentialsDesc")}
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
