import { redirect } from "next/navigation";
import { isGlobalOperator, listActorWorkspaces } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { filterWorkspacesForDeploymentScope, hasDeploymentWorkspaceScope } from "@/lib/deployment-workspace-scope";

export const dynamic = "force-dynamic";

function localizedPath(path: string, locale: string) {
  return `/${locale}${path}`;
}

export default async function IndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const actor = await requirePageActor();

  if (env.CONTROL_PLANE_MODE && isGlobalOperator(actor)) {
    redirect(localizedPath("/control-plane", locale));
  }

  const workspaces = filterWorkspacesForDeploymentScope(await listActorWorkspaces(actor));

  if (workspaces.length === 0) {
    redirect(hasDeploymentWorkspaceScope() ? localizedPath("/find-account", locale) : localizedPath("/workspaces/create", locale));
  }

  // Redirect to the first workspace by default
  redirect(localizedPath(`/workspaces/${workspaces[0].id}`, locale));
}
