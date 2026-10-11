import { listCatalogItems, listCatalogRequests, listCircles, listWorkspaceExternalResources, listWorkspaceToolLinks, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { getTranslations } from "next-intl/server";
import { type CatalogSearchParamValue } from "./catalog-ui";
import { ToolsDirectoryClient } from "./ToolsDirectoryClient";
import { ToolsViewSwitch } from "./ToolsViewSwitch";

export const dynamic = "force-dynamic";

export default async function ToolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string }>;
  searchParams: Promise<{ view?: CatalogSearchParamValue; surface?: CatalogSearchParamValue; type?: CatalogSearchParamValue; q?: CatalogSearchParamValue }>;
}) {
  const { locale, workspaceId } = await params;
  const { view } = await searchParams;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  await requireWorkspaceFeature(workspaceId, "TOOL_LINKS");
  const t = await getTranslations("tools");
  const selectedView = Array.isArray(view) ? view[0] : view;
  const initialView = selectedView === "grid" ? "grid" : "list";

  const [toolLinks, circles, catalog, catalogRequests, externalResources] = await Promise.all([
    listWorkspaceToolLinks(actor, { workspaceId }),
    listCircles(workspaceId),
    listCatalogItems(actor, workspaceId),
    listCatalogRequests(actor, { workspaceId, status: "PENDING" }),
    listWorkspaceExternalResources(actor, { workspaceId, take: 100 }),
  ]);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>Connect what is live, request realistic pilots, and keep apps, agents, data sources, and protected shared links governed in one place.</span>
            </div>
          </div>
          <ToolsViewSwitch listLabel={t("btnListView")} gridLabel={t("btnGridView")} />
        </div>
      </header>

      <ToolsDirectoryClient
        key={`${locale}:${workspaceId}`}
        workspaceId={workspaceId}
        initialView={initialView}
        initialCatalogItems={catalog.items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }))}
        initialRequests={catalogRequests.map((request) => ({
          ...request,
          createdAt: request.createdAt.toISOString(),
          decidedAt: request.decidedAt?.toISOString() ?? null,
          updatedAt: request.updatedAt.toISOString(),
        }))}
        canManageCatalog={catalog.canManage}
        initialLinks={toolLinks.map((link) => ({
          ...link,
          createdAt: link.createdAt.toISOString(),
          updatedAt: link.updatedAt.toISOString(),
          archivedAt: link.archivedAt?.toISOString() ?? null,
        }))}
        circles={circles.map((circle) => ({
          id: circle.id,
          name: circle.name,
        }))}
        initialExternalResources={externalResources.map((resource) => ({
          ...resource,
          createdAt: resource.createdAt.toISOString(),
          updatedAt: resource.updatedAt.toISOString(),
          archivedAt: resource.archivedAt?.toISOString() ?? null,
          lastEnrichedAt: resource.lastEnrichedAt?.toISOString() ?? null,
          mentions: resource.mentions.map((mention) => ({
            ...mention,
            mentionedAt: mention.mentionedAt?.toISOString() ?? null,
            redactedAt: mention.redactedAt?.toISOString() ?? null,
            createdAt: mention.createdAt.toISOString(),
          })),
        }))}
      />
    </>
  );
}
