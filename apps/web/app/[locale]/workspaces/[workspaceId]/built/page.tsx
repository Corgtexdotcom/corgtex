import { listBuildArtifacts, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { BuiltArtifactsClient } from "./BuiltArtifactsClient";

export const dynamic = "force-dynamic";

export default async function BuiltPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("built");
  const artifacts = await listBuildArtifacts(actor, { workspaceId });

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
        </div>
      </header>

      <BuiltArtifactsClient
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
