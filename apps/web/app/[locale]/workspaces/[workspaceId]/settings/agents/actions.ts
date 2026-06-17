"use server";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import {
  updateAgentConfig,
  updateCompanyUnderstandingGoalApplyMode,
  updateWorkspaceNewspaperCadence,
  type CompanyUnderstandingGoalApplyMode,
} from "@corgtex/domain";
import { revalidatePath } from "next/cache";

export async function toggleAgentAction(workspaceId: string, agentKey: string, enabled: boolean) {
  const actor = await requirePageActor();
  await updateAgentConfig(actor, { workspaceId, agentKey, enabled });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
}

export async function updateAgentModelAction(workspaceId: string, agentKey: string, modelOverride: string | null) {
  const actor = await requirePageActor();
  await updateAgentConfig(actor, { workspaceId, agentKey, modelOverride });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
}

export async function updateAgentNewspaperCadenceAction(
  workspaceId: string,
  cadence: "DAILY" | "WEEKLY" | "OFF",
) {
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await updateWorkspaceNewspaperCadence(actor, { workspaceId, cadence });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
  revalidatePath(`/workspaces/${workspaceId}/settings`);
}

export async function updateCompanyUnderstandingGoalApplyModeAction(
  workspaceId: string,
  mode: CompanyUnderstandingGoalApplyMode,
) {
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await updateCompanyUnderstandingGoalApplyMode(actor, { workspaceId, mode });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
  revalidatePath(`/workspaces/${workspaceId}/settings`);
}
