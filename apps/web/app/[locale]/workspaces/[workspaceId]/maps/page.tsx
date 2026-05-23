import { getContextMapData, requireWorkspaceMembership } from "@corgtex/domain";

import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import ContextMapClient, { type ContextMapClientData } from "./ContextMapClient";

export const dynamic = "force-dynamic";

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default async function ContextMapsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "CONTEXT_MAPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });

  const data = await getContextMapData(actor, { workspaceId });

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 24 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>Context Map</h1>
        <div className="nr-masthead-meta">
          <span>Evidence-backed company context rendered as a spatial graph.</span>
        </div>
      </header>
      <ContextMapClient workspaceId={workspaceId} data={serialize(data) as unknown as ContextMapClientData} />
    </>
  );
}
