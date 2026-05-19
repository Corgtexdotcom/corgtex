import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listCircleTree, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

import { requirePageActor } from "@/lib/auth";
import CircleGraph from "./CircleGraph";
import {
  collectCircleMembers,
  countAccountabilities,
  type CircleGraphCircle,
} from "./circleGraphHelpers";

export const dynamic = "force-dynamic";

function flattenCircles(nodes: CircleGraphCircle[]): CircleGraphCircle[] {
  return nodes.flatMap((node) => [node, ...flattenCircles(node.childCircles ?? [])]);
}

export default async function CirclesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const viewMode = view === "list" ? "list" : "graph";
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("circles");

  let treeData: Awaited<ReturnType<typeof listCircleTree>>;
  let isDemo = false;

  try {
    const [currentWorkspace, loadedTreeData] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
      listCircleTree(workspaceId).catch((error) => {
        console.error("[CirclesPage] listCircleTree failed:", error);
        throw error;
      }),
    ]);
    isDemo = currentWorkspace?.slug === "jnj-demo";
    treeData = loadedTreeData;
  } catch (error) {
    console.error("[CirclesPage] Failed to load circles data detailed:", error);
    return (
      <>
        <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        </header>
        <section className="ws-section">
          <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
            <h3 style={{ margin: "0 0 8px" }}>{t("errorLoadTitle")}</h3>
            <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
              {t("errorLoadDesc")}
            </p>
          </div>
        </section>
      </>
    );
  }

  const circles = flattenCircles(treeData);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>{t("pageDescription")}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Link href={`/workspaces/${workspaceId}/circles?view=graph`} className="secondary small" style={{ opacity: viewMode === "graph" ? 1 : 0.6, background: viewMode === "graph" ? "var(--bg-alt)" : "transparent" }}>{t("btnGraphView")}</Link>
            <Link href={`/workspaces/${workspaceId}/circles?view=list`} className="secondary small" style={{ opacity: viewMode === "list" ? 1 : 0.6, background: viewMode === "list" ? "var(--bg-alt)" : "transparent" }}>{t("btnListView")}</Link>
          </div>
        </div>
      </header>

      {viewMode === "graph" ? (
        <section className="ws-section circle-graph-section">
          {treeData.length === 0 ? (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>{t("whatIsCircleTitle")}</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                {t("whatIsCircleDescGraph")}
              </p>
            </div>
          ) : (
            <CircleGraph treeData={treeData} isDemo={isDemo} />
          )}
        </section>
      ) : (
        <section className="ws-section">
          {circles.length === 0 ? (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>{t("whatIsCircleTitle")}</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                {t("whatIsCircleDescList")}
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {circles.map((circle) => {
                const members = collectCircleMembers(circle);
                const accountabilityCount = countAccountabilities(circle);
                const roleNames = (circle.roles ?? []).map((role) => role.name);
                return (
                  <Link
                    key={circle.id}
                    href={`/workspaces/${workspaceId}/circles/${circle.id}`}
                    className="nr-item"
                    style={{ color: "inherit", display: "block", textDecoration: "none" }}
                  >
                    <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="nr-item-meta" style={{ marginBottom: 4 }}>
                          {circle.parentCircleId ? t("subcircleMeta") : t("topLevelCircleMeta")}
                        </div>
                        <strong className="nr-item-title" style={{ fontSize: "1.05rem" }}>
                          {t("circleTitle", { name: circle.name })}
                        </strong>
                      </div>
                      <span className="secondary small" style={{ whiteSpace: "nowrap" }}>{t("btnOpenCircle")}</span>
                    </div>

                    {circle.purposeMd && (
                      <div className="nr-excerpt" style={{ marginTop: 10 }}>{circle.purposeMd}</div>
                    )}
                    {circle.domainMd && (
                      <div className="nr-item-meta" style={{ marginTop: 6 }}>{t("domain", { domain: circle.domainMd })}</div>
                    )}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                      <span className="tag neutral">{t("roleCount", { count: circle.roles?.length ?? 0 })}</span>
                      <span className="tag neutral">{t("memberCount", { count: members.length })}</span>
                      <span className="tag neutral">{t("accountabilityCount", { count: accountabilityCount })}</span>
                      <span className="tag neutral">{t("subcircleCount", { count: circle.childCircles?.length ?? 0 })}</span>
                    </div>

                    {roleNames.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                        {roleNames.slice(0, 6).map((name) => (
                          <span key={name} className="tag info" style={{ fontSize: "0.72rem" }}>{name}</span>
                        ))}
                        {roleNames.length > 6 && (
                          <span className="tag" style={{ fontSize: "0.72rem" }}>+{roleNames.length - 6}</span>
                        )}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}
    </>
  );
}
