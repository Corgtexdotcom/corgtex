import { requirePageActor } from "@/lib/auth";
import { headers } from "next/headers";
import { AgentRegistryTab } from "./AgentRegistryTab";
import { AccessControlTab } from "./AccessControlTab";
import { ObservabilityTab } from "./ObservabilityTab";
import { SpendControlTab } from "./SpendControlTab";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function AgentGovernancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string; agentRunId?: string }>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const tab = search.tab ?? "registry";
  const t = await getTranslations("agents");

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const mcpUrl = `${origin}/api/mcp`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDesc")}</span>
        </div>
      </header>

      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        <a href={`/workspaces/${workspaceId}/agents?tab=registry`} className={`nr-tab ${tab === "registry" ? "nr-tab-active" : ""}`}>{t("tabRegistry")}</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=access`} className={`nr-tab ${tab === "access" ? "nr-tab-active" : ""}`}>{t("tabAccess")}</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=observability`} className={`nr-tab ${tab === "observability" ? "nr-tab-active" : ""}`}>{t("tabObservability")}</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=spend`} className={`nr-tab ${tab === "spend" ? "nr-tab-active" : ""}`}>{t("tabSpend")}</a>
      </div>

      {tab === "registry" && <AgentRegistryTab workspaceId={workspaceId} actor={actor} />}
      {tab === "access" && <AccessControlTab workspaceId={workspaceId} actor={actor} mcpUrl={mcpUrl} />}
      {tab === "observability" && <ObservabilityTab workspaceId={workspaceId} actor={actor} searchParams={search} />}
      {tab === "spend" && <SpendControlTab workspaceId={workspaceId} actor={actor} />}
    </>
  );
}
