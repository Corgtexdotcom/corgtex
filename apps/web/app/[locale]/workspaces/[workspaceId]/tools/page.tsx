import { listCatalogItems, listCatalogRequests, listCircles, listWorkspaceToolLinks, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { getTranslations } from "next-intl/server";
import { TYPE_ORDER, type CatalogItemType } from "./catalog-ui";
import { ToolsDirectoryClient } from "./ToolsDirectoryClient";

export const dynamic = "force-dynamic";

function normalizeCatalogType(value: string | undefined): CatalogItemType | "ALL" {
  return TYPE_ORDER.includes(value as CatalogItemType) ? value as CatalogItemType : "ALL";
}

export default async function ToolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; type?: string; q?: string }>;
}) {
  const { workspaceId } = await params;
  const { view, type, q } = await searchParams;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  await requireWorkspaceFeature(workspaceId, "TOOL_LINKS");
  const t = await getTranslations("tools");

  const [toolLinks, circles, catalog, catalogRequests] = await Promise.all([
    listWorkspaceToolLinks(actor, { workspaceId }),
    listCircles(workspaceId),
    listCatalogItems(actor, workspaceId),
    listCatalogRequests(actor, { workspaceId, status: "PENDING" }),
  ]);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>Find, favorite, request, publish, and govern the apps, agents, connectors, automations, data, and shared tools that power this workspace.</span>
            </div>
          </div>
          <div className="actions-inline">
            <a
              href={`/workspaces/${workspaceId}/tools?view=list`}
              className="link-button small"
              style={{ opacity: view === "grid" ? 0.62 : 1 }}
            >
              {t("btnListView")}
            </a>
            <a
              href={`/workspaces/${workspaceId}/tools?view=grid`}
              className="link-button small"
              style={{ opacity: view === "grid" ? 1 : 0.62 }}
            >
              {t("btnGridView")}
            </a>
          </div>
        </div>
      </header>

      <ToolsDirectoryClient
        workspaceId={workspaceId}
        initialView={view === "grid" ? "grid" : "list"}
        initialType={normalizeCatalogType(type)}
        initialQuery={q?.slice(0, 120) ?? ""}
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
      />
    </>
  );
}
