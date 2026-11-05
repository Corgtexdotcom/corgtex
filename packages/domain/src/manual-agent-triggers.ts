import { invariant } from "./errors";

/** Only workflows whose inputs are expressible by an authored manual request.
 * Internal/event agents must use their own admission and payload contracts. */
export const MANUAL_AGENT_TRIGGERS = {
  "inbox-triage": { jobType: "agent.inbox-triage", required: null },
  "meeting-summary": { jobType: "agent.meeting-summary", required: "meetingId" },
  "action-extraction": { jobType: "agent.action-extraction", required: "meetingId" },
  "proposal-drafting": { jobType: "agent.proposal-drafting", required: "prompt" },
  "constitution-update-trigger": { jobType: "agent.constitution-update-trigger", required: "proposalId" },
  "constitution-synthesis": { jobType: "agent.constitution-synthesis", required: null },
  "company-understanding": { jobType: "agent.company-understanding", required: null },
  "brain-maintenance": { jobType: "agent.brain-maintenance", required: null },
} as const;

export type ManualAgentKey = keyof typeof MANUAL_AGENT_TRIGGERS;

export function parseManualAgentTrigger(value: unknown) {
  invariant(value && typeof value === "object" && !Array.isArray(value), 400, "INVALID_INPUT", "Manual agent request must be an object.");
  const input = value as Record<string, unknown>;
  invariant(typeof input.agentKey === "string" && Object.hasOwn(MANUAL_AGENT_TRIGGERS, input.agentKey),
    400, "INVALID_INPUT", "Unsupported manual agent key.");
  const agentKey = input.agentKey as ManualAgentKey;
  const optionalText = (field: "prompt" | "meetingId" | "proposalId") => {
    const text = input[field];
    invariant(text == null || typeof text === "string", 400, "INVALID_INPUT", `${field} must be a string.`);
    return text?.trim() || null;
  };
  const parsed = { agentKey, prompt: optionalText("prompt"), meetingId: optionalText("meetingId"), proposalId: optionalText("proposalId") };
  const required = MANUAL_AGENT_TRIGGERS[agentKey].required;
  invariant(!required || parsed[required], 400, "INVALID_INPUT", `${agentKey} requires ${required}.`);
  return parsed;
}
