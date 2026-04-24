import { requirePageActor } from "@/lib/auth";
import { headers } from "next/headers";
import { AgentRegistryTab } from "./AgentRegistryTab";
import { AccessControlTab } from "./AccessControlTab";
import { ObservabilityTab } from "./ObservabilityTab";
import { SpendControlTab } from "./SpendControlTab";

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

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const mcpUrl = `${origin}/api/mcp`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Agent Governance</h1>
        <div className="nr-masthead-meta">
          <span>Manage AI autonomous agents, access controls, traces, and spending.</span>
        </div>
      </header>

      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        <a href={`/workspaces/${workspaceId}/agents?tab=registry`} className={`nr-tab ${tab === "registry" ? "nr-tab-active" : ""}`}>Registry</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=access`} className={`nr-tab ${tab === "access" ? "nr-tab-active" : ""}`}>Access Control</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=observability`} className={`nr-tab ${tab === "observability" ? "nr-tab-active" : ""}`}>Observability</a>
        <a href={`/workspaces/${workspaceId}/agents?tab=spend`} className={`nr-tab ${tab === "spend" ? "nr-tab-active" : ""}`}>Spend Control</a>
      </div>

      {tab === "registry" && <AgentRegistryTab workspaceId={workspaceId} actor={actor} />}
      {tab === "access" && <AccessControlTab workspaceId={workspaceId} actor={actor} mcpUrl={mcpUrl} />}
      {tab === "observability" && <ObservabilityTab workspaceId={workspaceId} actor={actor} searchParams={search} />}
      {tab === "spend" && <SpendControlTab workspaceId={workspaceId} actor={actor} />}
    </>
  );
}
