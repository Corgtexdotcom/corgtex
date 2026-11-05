import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const f = vi.hoisted(() => {
  const tx = {
    agentRequestInput: { create: vi.fn(async ({ data }) => ({ id: "request-1", ...data })) },
    workflowJob: { create: vi.fn(async ({ data }) => ({ id: "job-1", ...data })) },
    auditLog: { create: vi.fn() },
  };
  return { tx, transaction: vi.fn(async (work) => work(tx)), membership: vi.fn(),
    actor: { kind: "user", user: { id: "user-1" } }, rate: vi.fn(async () => ({ allowed: true })),
    agents: Object.fromEntries([
      "runInboxTriageAgent", "runMeetingSummaryAgent", "runActionExtractionAgent", "runProposalDraftingAgent",
      "runConstitutionUpdateTriggerAgent", "runConstitutionSynthesisAgent", "runCompanyUnderstandingAgent",
    ].map(name => [name, vi.fn(async (_input: Record<string, unknown>) => ({ status: "COMPLETED" }))])),
    maintenance: vi.fn(async () => ({ recoverOrVerifyExisting: async () => true })),
  };
});
vi.mock("@corgtex/shared", () => ({ prisma: { $transaction: f.transaction }, checkRateLimit: f.rate, RATE_LIMITS: { AGENT_PER_WORKSPACE: {} } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./source-lineage", () => ({}));
vi.mock("./digest-lineage", () => ({}));
vi.mock("./proposals", () => ({}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: async () => f.actor }));
vi.mock("@/lib/http", () => ({ handleRouteError: (error: { status?: number; code?: string }) =>
  Response.json({ error: { code: error.code } }, { status: error.status ?? 500 }) }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("./agent-runs"), ...await import("./errors"), ...await import("./manual-agent-triggers"),
  // Exercise the actual dispatcher while replacing claim/lineage I/O and provider execution.
  withMeetingTranscriptWorker: async (_params: unknown, work: (actor: unknown) => unknown) => work(f.actor),
}));
vi.mock("@corgtex/agents", () => f.agents);
vi.mock("../../workflows/src/brain-maintenance-jobs", () => ({ prepareMaintenanceClaim: f.maintenance }));

import { POST } from "../../../apps/web/app/api/workspaces/[workspaceId]/agent-runs/route";
import { triggerAgentRun } from "./agent-runs";
import { runAgentWorkflowJob } from "../../workflows/src/handlers/agent-dispatch";

const supported = [
  ["inbox-triage", {}, "runInboxTriageAgent"],
  ["meeting-summary", { meetingId: " meeting-1 " }, "runMeetingSummaryAgent"],
  ["action-extraction", { meetingId: " meeting-1 " }, "runActionExtractionAgent"],
  ["proposal-drafting", { prompt: " Human guidance " }, "runProposalDraftingAgent"],
  ["constitution-update-trigger", { proposalId: " proposal-1 " }, "runConstitutionUpdateTriggerAgent"],
  ["constitution-synthesis", {}, "runConstitutionSynthesisAgent"],
  ["company-understanding", {}, "runCompanyUnderstandingAgent"],
  ["brain-maintenance", {}, null],
] as const;
const invalid = [
  ...["daily-check-in", "brain-absorb", "slack-agent", "crm-drip-followup", "crm-email-extraction", "crm-lead-enrichment", "unknown", "toString", "__proto__"].map(agentKey => ({ agentKey })),
  {}, { agentKey: 42 }, { agentKey: ["inbox-triage"] },
  { agentKey: "proposal-drafting" }, { agentKey: "proposal-drafting", prompt: "  " },
  { agentKey: "meeting-summary" }, { agentKey: "action-extraction", meetingId: " " },
  { agentKey: "constitution-update-trigger", proposalId: " " },
  ...["prompt", "meetingId", "proposalId"].flatMap(field => [42, {}, []].map(value => ({ agentKey: "inbox-triage", [field]: value }))),
];
async function post(body: unknown, raw = false) {
  return POST(new NextRequest("http://localhost/api/workspaces/ws-1/agent-runs", {
    method: "POST", body: raw ? String(body) : JSON.stringify(body), headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ workspaceId: "ws-1" }) });
}
beforeEach(() => vi.clearAllMocks());

describe("manual API → authored request → dispatcher", () => {
  it.each(supported)("dispatches supported %s without a missing-input no-op", async (agentKey, input, agent) => {
    const response = await post({ agentKey, ...input });
    expect(response.status).toBe(201);
    const { job } = await response.json();
    const authored = f.tx.agentRequestInput.create.mock.calls[0][0].data;
    expect(authored).toMatchObject({ userId: "user-1", workspaceId: "ws-1", agentKey });
    expect(job.payload).toMatchObject({ triggerType: "MANUAL", requestInputId: "request-1" });
    expect(job.payload).not.toHaveProperty("prompt");
    const result = await runAgentWorkflowJob(job);
    expect(result).toEqual({ status: "COMPLETED" });
    if (agent) {
      const called = f.agents[agent].mock.calls[0][0];
      expect(called).toMatchObject({ workspaceId: "ws-1", triggerRef: "job-1" });
      if ("meetingId" in input) expect(called.meetingId).toBe("meeting-1");
      if ("proposalId" in input) expect(called.proposalId).toBe("proposal-1");
      if ("prompt" in input) {
        expect(authored.prompt).toBe("Human guidance");
        expect(called.requestInputId).toBe("request-1");
        expect(called.prompt).toBe(""); // Provider rereads the canonical authored request.
      }
    } else expect(f.maintenance).toHaveBeenCalled();
    expect(f.tx.auditLog.create).toHaveBeenCalled();
    expect(f.membership).toHaveBeenCalledTimes(2);
  });
  it.each(invalid)("rejects invalid API input %j before persistence", async body => {
    expect((await post(body)).status).toBe(400);
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.tx.agentRequestInput.create).not.toHaveBeenCalled();
    expect(f.tx.workflowJob.create).not.toHaveBeenCalled();
  });
  it.each([null, [], "hello", 42, true].map(body => [body]))("rejects non-object body %j", async body => {
    expect((await post(body)).status).toBe(400);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    expect((await post("{", true)).status).toBe(400);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(invalid)("enforces the same domain contract for direct callers %j", async input => {
    await expect(triggerAgentRun(f.actor as any, { workspaceId: "ws-1", ...input } as any)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("keeps caller-supplied author and lineage handles out of the queued payload", async () => {
    expect((await post({ agentKey: "proposal-drafting", prompt: "Human guidance", workspaceId: "other",
      userId: "other", requestInputId: "forged", feedbackInputId: "forged", memberId: "other" })).status).toBe(201);
    expect(f.tx.agentRequestInput.create).toHaveBeenCalledWith({ data: {
      workspaceId: "ws-1", userId: "user-1", agentKey: "proposal-drafting", prompt: "Human guidance", meetingId: null, proposalId: null,
    } });
    expect(f.tx.workflowJob.create.mock.calls[0][0].data.payload).toEqual({
      triggerType: "MANUAL", requestInputId: "request-1", meetingId: null, proposalId: null,
    });
  });
  it("rejects a denied admission before any transaction", async () => {
    const { AppError } = await import("./errors");
    f.membership.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "No membership"));
    expect((await post({ agentKey: "company-understanding" })).status).toBe(403);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("preserves the workspace rate limit", async () => {
    f.rate.mockResolvedValueOnce({ allowed: false });
    expect((await post({ agentKey: "company-understanding" })).status).toBe(429);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rechecks membership before writing after admission", async () => {
    const { AppError } = await import("./errors");
    f.membership.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Membership revoked"));
    expect((await post({ agentKey: "company-understanding" })).status).toBe(403);
    expect(f.tx.agentRequestInput.create).not.toHaveBeenCalled();
    expect(f.tx.workflowJob.create).not.toHaveBeenCalled();
  });
});
