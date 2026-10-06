"use server";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import {
  updateAgentConfig,
  updateCompanyUnderstandingGoalApplyMode,
  updateWorkspaceNewspaperSchedule,
  updateWorkspaceSlackNudgeWindow,
  type CompanyUnderstandingGoalApplyMode,
  type NewspaperWeekday,
  type SlackNudgeWindow,
} from "@corgtex/domain";
import { revalidatePath } from "next/cache";
import { assertAgentModelOverrideAllowed } from "../../agents/model-override-options";

export async function toggleAgentAction(workspaceId: string, agentKey: string, enabled: boolean) {
  const actor = await requirePageActor();
  await updateAgentConfig(actor, { workspaceId, agentKey, enabled });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
}

export async function updateAgentModelAction(workspaceId: string, agentKey: string, modelOverride: string | null) {
  const actor = await requirePageActor();
  assertAgentModelOverrideAllowed(modelOverride);
  await updateAgentConfig(actor, { workspaceId, agentKey, modelOverride });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
}

export async function updateAgentNewspaperScheduleAction(
  workspaceId: string,
  schedule: {
    cadence?: "DAILY" | "WEEKLY" | "OFF";
    weekday?: NewspaperWeekday;
    localTime?: string;
    timeZone?: string;
  },
) {
  await enforceDemoGuard(workspaceId);

  const actor = await requirePageActor();
  await updateWorkspaceNewspaperSchedule(actor, { workspaceId, ...schedule });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
  revalidatePath(`/workspaces/${workspaceId}/settings`);
}

export async function updateSlackNudgeWindowAction(workspaceId: string, window: SlackNudgeWindow | null) {
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await updateWorkspaceSlackNudgeWindow(actor, { workspaceId, window });
  revalidatePath(`/workspaces/${workspaceId}/settings/agents`);
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
