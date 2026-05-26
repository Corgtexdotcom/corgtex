import { getContextMapData, requireWorkspaceMembership } from "@corgtex/domain";

import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import ContextMapClient, { type ContextMapClientData } from "./ContextMapClient";

export const dynamic = "force-dynamic";

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default async function ContextMapsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; stale?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  await requireWorkspaceFeature(workspaceId, "CONTEXT_MAPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });

  const [data, mapAiEnabled] = await Promise.all([
    getContextMapData(actor, {
      workspaceId,
      mapViewId: query.view ?? null,
      includeStale: query.stale === "1",
    }),
    isWorkspaceFeatureEnabled(workspaceId, "CONTEXT_MAP_AI"),
  ]);

  return (
    <div className="context-map-page">
      <header className="nr-masthead context-map-page-header" style={{ textAlign: "left" }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>Context Map</h1>
        <div className="nr-masthead-meta">
          <span>Evidence-backed company context rendered as a spatial graph.</span>
        </div>
      </header>
      <ContextMapClient
        workspaceId={workspaceId}
        data={serialize(data) as unknown as ContextMapClientData}
        includeStale={query.stale === "1"}
        mapAiEnabled={mapAiEnabled}
      />
    </div>
  );
}
