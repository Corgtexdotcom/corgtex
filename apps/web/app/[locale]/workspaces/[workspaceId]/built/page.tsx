import { listBuildArtifactPage, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { getTranslations } from "next-intl/server";
import { BuiltArtifactsClient } from "./BuiltArtifactsClient";

import { HistoryWindowNavigation } from "@/lib/components/HistoryWindowNavigation";

export const dynamic = "force-dynamic";

export default async function BuiltPage({
  params, searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<{cursor?: string}>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  await requireWorkspaceFeature(workspaceId, "BUILD_ARTIFACTS");
  const t = await getTranslations("built");
  const cursor = (await searchParams)?.cursor;
  const window = await listBuildArtifactPage(actor, { workspaceId, cursor });
  const artifacts = window.items;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>{t("pageDescription")}</span>
            </div>
          </div>
        </div>
      </header>

      <HistoryWindowNavigation limited={!window.complete || Boolean(cursor)}
        nextHref={window.nextCursor ? `?cursor=${encodeURIComponent(window.nextCursor)}` : null}
        latestHref={cursor ? "?" : null}
        labels={{limited: t("historyLimited"), unavailable: t("historyUnavailable"), older: t("historyOlder"), latest: t("historyLatest")}} />
      <BuiltArtifactsClient
        key={cursor ?? "latest"}
        historyLimited={!window.complete || Boolean(cursor)}
        workspaceId={workspaceId}
        initialArtifacts={artifacts.map((artifact) => ({
          ...artifact,
          publicEnabledAt: artifact.publicEnabledAt?.toISOString() ?? null,
          publicRevokedAt: artifact.publicRevokedAt?.toISOString() ?? null,
          mergedAt: artifact.mergedAt?.toISOString() ?? null,
          closedAt: artifact.closedAt?.toISOString() ?? null,
          createdAt: artifact.createdAt.toISOString(),
          updatedAt: artifact.updatedAt.toISOString(),
          assets: artifact.assets.map((asset) => ({
            ...asset,
            createdAt: asset.createdAt.toISOString(),
          })),
        }))}
      />
    </>
  );
}
