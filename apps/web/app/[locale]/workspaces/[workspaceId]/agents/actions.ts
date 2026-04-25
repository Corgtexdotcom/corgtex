"use server";

import { requirePageActor } from "@/lib/auth";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { updateAgentConfig, updateAgentIdentity, submitAgentFeedback } from "@corgtex/domain";
import { revalidatePath } from "next/cache";


export async function toggleAgentAction(workspaceId: string, agentKey: string, enabled: boolean) {
  const actor = await requirePageActor();
  await updateAgentConfig(actor, { workspaceId, agentKey, enabled });
  revalidatePath(`/workspaces/${workspaceId}/agents`);
}

export async function updateAgentModelAction(workspaceId: string, agentKey: string, modelOverride: string | null) {
  const actor = await requirePageActor();
  await updateAgentConfig(actor, { workspaceId, agentKey, modelOverride });
  revalidatePath(`/workspaces/${workspaceId}/agents`);
}

export async function updateAgentSpendLimitAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = String(formData.get("workspaceId"));
  const agentIdentityId = String(formData.get("agentIdentityId"));
  
  const rawMaxSpend = String(formData.get("maxSpendPerRunCents"));
  const rawMaxRuns = String(formData.get("maxRunsPerDay"));
  
  const maxSpendPerRunCents = rawMaxSpend ? Math.round(parseFloat(rawMaxSpend) * 100) : null;
  const maxRunsPerDay = rawMaxRuns ? parseInt(rawMaxRuns, 10) : null;

  await updateAgentIdentity(actor, {
    workspaceId,
    agentIdentityId,
    maxSpendPerRunCents,
    maxRunsPerDay
  });

  revalidatePath(`/workspaces/${workspaceId}/agents`);
}

export async function updateAgentGovernancePolicyAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = String(formData.get("workspaceId"));
  const agentKey = String(formData.get("agentKey"));
  const governancePolicy = String(formData.get("governancePolicy") || "");

  await updateAgentConfig(actor, { workspaceId, agentKey, governancePolicy });
  revalidatePath(`/workspaces/${workspaceId}/agents`);
}

export async function submitAgentFeedbackAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = String(formData.get("workspaceId"));
  const agentRunId = String(formData.get("agentRunId"));
  const stepId = String(formData.get("stepId"));
  const feedback = String(formData.get("feedback"));

  await submitAgentFeedback(actor, { workspaceId, agentRunId, stepId, feedback });
  revalidatePath(`/workspaces/${workspaceId}/agents`);
}
