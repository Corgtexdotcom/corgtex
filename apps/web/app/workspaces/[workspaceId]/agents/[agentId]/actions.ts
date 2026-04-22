"use server";

import { requirePageActor } from "@/lib/auth";
import { assignAgentToCircle, removeAgentFromCircle, updateAgentBehavior } from "@corgtex/domain";
import { revalidatePath } from "next/cache";

export async function updateBehaviorAction(agentId: string, workspaceId: string, behaviorMd: string) {
  const actor = await requirePageActor();
  await updateAgentBehavior(actor, { workspaceId, agentIdentityId: agentId, behaviorMd });
  revalidatePath(`/workspaces/${workspaceId}/agents/${agentId}`);
}

export async function assignCircleAction(agentId: string, workspaceId: string, circleId: string, roleId?: string) {
  const actor = await requirePageActor();
  await assignAgentToCircle(actor, { workspaceId, agentIdentityId: agentId, circleId, roleId });
  revalidatePath(`/workspaces/${workspaceId}/agents/${agentId}`);
  revalidatePath(`/workspaces/${workspaceId}/circles`);
}

export async function removeCircleAction(agentId: string, workspaceId: string, circleId: string) {
  const actor = await requirePageActor();
  await removeAgentFromCircle(actor, { workspaceId, agentIdentityId: agentId, circleId });
  revalidatePath(`/workspaces/${workspaceId}/agents/${agentId}`);
  revalidatePath(`/workspaces/${workspaceId}/circles`);
}
