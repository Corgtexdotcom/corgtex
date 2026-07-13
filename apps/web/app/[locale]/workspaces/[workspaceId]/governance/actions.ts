"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import {
  replayEvent,
  replayWorkflowJob,
  triggerAgentRun,
  recalculateGovernanceScore,
  updateApprovalPolicy
} from "@corgtex/domain";

export async function replayEventAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await replayEvent(actor, {
    workspaceId,
    eventId: asString(formData, "eventId"),
  });
  refresh(workspaceId);
}

export async function replayWorkflowJobAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await replayWorkflowJob(actor, {
    workspaceId,
    workflowJobId: asString(formData, "workflowJobId"),
  });
  refresh(workspaceId);
}

export async function triggerAgentRunAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await triggerAgentRun(actor, {
    workspaceId,
    agentKey: asString(formData, "agentKey") as "inbox-triage" | "meeting-summary" | "action-extraction" | "proposal-drafting" | "constitution-update-trigger" | "constitution-synthesis",
    prompt: asOptional(formData, "prompt"),
    meetingId: asOptional(formData, "meetingId"),
    proposalId: asOptional(formData, "proposalId"),
  });
  refresh(workspaceId);
}


export async function updateApprovalPolicyAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateApprovalPolicy(actor, {
    workspaceId,
    subjectType: asString(formData, "subjectType"),
    mode: asOptional(formData, "mode") ?? undefined,
    quorumPercent: formData.has("quorumPercent") ? Number.parseInt(asString(formData, "quorumPercent"), 10) : undefined,
    minApproverCount: formData.has("minApproverCount") ? Number.parseInt(asString(formData, "minApproverCount"), 10) : undefined,
    decisionWindowHours: formData.has("decisionWindowHours") ? Number.parseInt(asString(formData, "decisionWindowHours"), 10) : undefined,
  });
  refresh(workspaceId);
}

export async function recalculateGovernanceScoreAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await recalculateGovernanceScore(actor, workspaceId, thirtyDaysAgo, now);
  refresh(workspaceId);
}

export async function discardFailedJobAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  const { discardFailedJob } = await import("@corgtex/domain");
  await discardFailedJob(actor, {
    workspaceId,
    workflowJobId: asString(formData, "workflowJobId"),
  });
  
  refresh(workspaceId);
}
