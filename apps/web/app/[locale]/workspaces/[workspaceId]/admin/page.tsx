import { requirePageActor } from "@/lib/auth";
import { notFound } from "next/navigation";
import { prisma } from "@corgtex/shared";
import { isGlobalOperator, listAllWorkspaces, listAllUsers } from "@corgtex/domain";
import { AdminDashboardClient } from "./AdminDashboardClient";
import { getTranslations } from "next-intl/server";

export default async function GlobalAdminPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("admin");

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId }
  });

  if (!workspace || !isGlobalOperator(actor)) {
    notFound();
  }

  const [workspaces, users] = await Promise.all([
    listAllWorkspaces(actor),
    listAllUsers(actor),
  ]);

  return (
    <div className="stack" style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header className="page-header" style={{ marginBottom: 24 }}>
        <h1 className="title-lg">{t("platformAdmin")}</h1>
        <p className="muted">{t("platformAdminDesc")}</p>
      </header>
      
      <AdminDashboardClient workspaces={workspaces} users={users} workspaceId={workspaceId} />
    </div>
  );
}
