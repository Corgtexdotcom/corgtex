import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { HistoryRecoveryForm } from "./HistoryRecoveryForm";

export const dynamic = "force-dynamic";

export default async function HistoryRecoveryPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  if (actor.kind !== "user" || membership?.role !== "ADMIN" || membership.id === "global-operator") notFound();
  const t = await getTranslations("historyRecovery");
  return (
    <section className="ws-section">
      <h1>{t("title")}</h1>
      <p>{t("description")}</p>
      <HistoryRecoveryForm workspaceId={workspaceId} />
    </section>
  );
}
