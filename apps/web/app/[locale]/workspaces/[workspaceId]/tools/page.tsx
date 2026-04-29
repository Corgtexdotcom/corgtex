import { listCircles, listWorkspaceToolLinks, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { ToolsDirectoryClient } from "./ToolsDirectoryClient";

export const dynamic = "force-dynamic";

export default async function ToolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("tools");

  const [toolLinks, circles] = await Promise.all([
    listWorkspaceToolLinks(actor, { workspaceId }),
    listCircles(workspaceId),
  ]);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>{t("pageDescription")}</span>
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
