import { redirect } from "next/navigation";
import { listActorWorkspaces } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";


export default async function IndexPage() {
  const actor = await requirePageActor();
  const workspaces = await listActorWorkspaces(actor);

  if (workspaces.length === 0) {
    redirect("/workspaces/create");
  }

  // Redirect to the first workspace by default
  redirect(`/workspaces/${workspaces[0].id}`);
}
