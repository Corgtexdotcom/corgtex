import { redirect } from "next/navigation";
import { isGlobalOperator, listActorWorkspaces } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";


export default async function IndexPage() {
  const actor = await requirePageActor();

  if (env.CONTROL_PLANE_MODE && isGlobalOperator(actor)) {
    redirect("/control-plane");
  }

  const workspaces = await listActorWorkspaces(actor);

  if (workspaces.length === 0) {
    redirect("/workspaces/create");
  }

  // Redirect to the first workspace by default
  redirect(`/workspaces/${workspaces[0].id}`);
}
