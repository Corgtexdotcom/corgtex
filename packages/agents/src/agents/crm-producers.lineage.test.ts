import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LineageRoot } from "@corgtex/domain";

const f = vi.hoisted(() => ({
  job: {} as any, qualification: {} as any, lead: {} as any, contact: {} as any,
  unknown: new Set<string>(), revoked: false, private: false,
  modelExtract: vi.fn(), modelChat: vi.fn(), send: vi.fn(), applyExtraction: vi.fn(), applyEnrichment: vi.fn(), record: vi.fn(), search: vi.fn(),
  runtime: vi.fn(), operations: [] as any[], roots: [] as any[],
}));
vi.mock("@corgtex/shared", () => ({ prisma: {
  workflowJob: { findFirst: vi.fn(async () => f.job) },
  crmQualification: { findFirst: vi.fn(async () => f.qualification) },
  demoLead: { findFirst: vi.fn(async () => f.lead) },
  crmContact: { findFirst: vi.fn(async () => f.contact) },
  $transaction: vi.fn(async (fn: any) => fn({})),
}, sendEmail: f.send }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract: f.modelExtract, chat: f.modelChat } }));
vi.mock("../tools/web-search", () => ({ executeWebSearch: f.search }));
vi.mock("@corgtex/domain", () => ({
  invariant: (condition: unknown, _status: number, code: string) => { if (!condition) throw new Error(code); },
  captureArtifactInputProof: vi.fn(async (_actor: any, _ws: string, inputs: any[]) => {
    if (inputs.some(input => f.unknown.has(input.kind))) throw new Error("UNKNOWN_LINEAGE");
    f.roots.push(...inputs);
    return inputs.map(input => ({ kind: input.kind, id: input.id, fingerprint: "captured" }));
  }),
  captureImmutableArtifactInputProof: vi.fn(async (_actor: any, _ws: string, roots: any[]) => roots.map(root => ({ ...root, kind: "ArtifactInputSnapshot" }))),
  mergeArtifactInputProofs: (...roots: any[][]) => roots.flat(),
  isArtifactInputProofReadable: vi.fn(async () => !f.revoked),
  isArtifactInputProofPubliclyShareable: vi.fn(async () => !f.revoked && !f.private),
  applyExtractionResult: f.applyExtraction, applyEnrichmentResult: f.applyEnrichment, recordDripFollowUp: f.record,
}));
vi.mock("../runtime", () => ({ executeAgentRun: f.runtime }));
import { runCrmEmailExtractionAgent } from "./crm-email-extraction";
import { runCrmDripFollowupAgent } from "./crm-drip-followup";
import { runCrmLeadEnrichmentAgent } from "./crm-lead-enrichment";

const emailPayload = { eventId: "event", aggregateId: "qualification", qualificationId: "qualification" };
const leadPayload = { demoLeadId: "lead", followUpNumber: 1 };
const enrichmentPayload = { eventId: "event", aggregateId: "contact", email: "lead@synthetic.test" };
const params = (payload: any) => ({ workspaceId: "alpha", triggerRef: "job", payload });
function job(type: string, payload: any) { f.job = { id: "job", workspaceId: "alpha", type: `agent.${type}`, eventId: "event", payload, createdAt: new Date("2026-10-12") }; }

describe("CRM producers capture actual inputs before effects", () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.unknown.clear(); f.revoked = false; f.private = false; f.roots = []; f.operations = [];
    f.qualification = { id: "qualification", workspaceId: "alpha", demoLeadId: "lead", responseChannel: "email_reply", rawEmailReply: "Our original reply", rawEmailSubject: "Original subject", createdAt: new Date("2026-10-12") };
    f.lead = { id: "lead", workspaceId: "alpha", email: "lead@synthetic.test", source: "demo_gate", companyHint: "Synthetic", utmSource: null, followUpCount: 0, convertedContactId: null };
    f.contact = { id: "contact", workspaceId: "alpha", email: "lead@synthetic.test", company: "Synthetic", tags: ["existing"], archivedAt: null, accountId: null };
    f.modelExtract.mockResolvedValue({ output: { companyName: "Synthetic", confidence: 0.8, industry: "Software" } });
    f.modelChat.mockResolvedValue({ content: "A proven draft" }); f.send.mockResolvedValue({ status: "SENT", providerMessageId: "provider-message" });
    f.record.mockImplementation(async (_ws: string, _id: string, _body: string, opts: any) => ({ operationId: opts.operationId, delivery: await opts.send(f.lead.email, opts.operationId) }));
    f.runtime.mockImplementation(async (options: any) => {
      const receipt = Object.freeze({ kind: "agent-input-receipt" });
      const op = async (name: string, _input: any, fn: any, proof: any) => { f.operations.push({ name, proof }); return fn({modelRequest: (request: any) => request}); };
      const helpers = { plannedInputReceipt: receipt, behaviorContext: "Known behavior", behaviorLineageRoots: [{ kind: "AgentIdentity", id: "identity", fingerprint: "known" }], captureInputs: vi.fn(async (roots: LineageRoot[]) => { expect(roots.length).toBeGreaterThan(0); return receipt; }), step: op, tool: op };
      const context = await options.buildContext(helpers);
      expect(options.contextLineageRoots(context).length).toBeGreaterThan(0);
      return options.execute(context, helpers, "run", "test-model");
    });
  });
  it("captures typed raw email, job and behavior receipts, never treating generated qualification fields as originals", async () => {
    job("crm-email-extraction", emailPayload);
    const result = await runCrmEmailExtractionAgent(params(emailPayload));
    expect(f.roots.map(root => root.kind)).toEqual(["WorkflowJobInput", "CrmQualificationEmailInput"]);
    expect(f.roots[1].snapshot.rawEmailReply).toBe("Our original reply");
    expect(f.roots[1].snapshot).not.toHaveProperty("companyName");
    expect(f.modelExtract.mock.calls[0][0].input).toBe("Our original reply");
    expect(f.modelExtract.mock.calls[0][0].instruction).toContain("Known behavior");
    expect(f.applyExtraction.mock.calls[0][3].lineageRoots.map((root: any) => root.kind)).toContain("AgentIdentity");
    expect(result).toEqual(expect.objectContaining({ lineageReceipt: { kind: "agent-input-receipt" } }));
    expect(f.operations.filter(op => op.name.startsWith("model.") || op.name === "update-qualification").every(op => op.proof.receipt)).toBe(true);
  });
  it("rejects legacy unproven job input before starting a run or model", async () => {
    job("crm-email-extraction", emailPayload); f.unknown.add("WorkflowJobInput");
    await expect(runCrmEmailExtractionAgent(params(emailPayload))).rejects.toThrow("UNKNOWN_LINEAGE");
    expect(f.runtime).not.toHaveBeenCalled(); expect(f.modelExtract).not.toHaveBeenCalled();
  });
  it("does not recertify an old dispatch email by looking up its new contact ID", async () => {
    job("crm-lead-enrichment", { ...enrichmentPayload, email: "changed@synthetic.test" });
    await expect(runCrmLeadEnrichmentAgent(params(enrichmentPayload))).rejects.toThrow("SOURCE_CHANGED");
    expect(f.runtime).not.toHaveBeenCalled(); expect(f.applyEnrichment).not.toHaveBeenCalled();
  });
  it("aborts extraction persistence when an input is revoked during the model call", async () => {
    job("crm-email-extraction", emailPayload);
    f.modelExtract.mockImplementation(async () => { f.revoked = true; return { output: { companyName: "Copied" } }; });
    await expect(runCrmEmailExtractionAgent(params(emailPayload))).rejects.toThrow("SOURCE_CHANGED");
    expect(f.applyExtraction).not.toHaveBeenCalled();
  });
  it("uses no transient provider input and never exports a search query without a stored grant", async () => {
    job("crm-lead-enrichment", enrichmentPayload);
    const result = await runCrmLeadEnrichmentAgent(params(enrichmentPayload));
    expect(f.search).not.toHaveBeenCalled(); expect(result).toEqual(expect.objectContaining({ resultJson: expect.objectContaining({ searchUsed: false }) }));
    expect(f.modelExtract.mock.calls[0][0].instruction).toContain("No web results were fetched or verified");
    expect(f.applyEnrichment.mock.calls[0][3].lineageRoots.map((root: any) => root.kind)).toEqual(expect.arrayContaining(["CrmContact", "WorkflowJobInput", "AgentIdentity"]));
  });
  it("rejects public-destination email before the model when any admitted input is private", async () => {
    job("crm-drip-followup", leadPayload); f.private = true;
    await expect(runCrmDripFollowupAgent(params(leadPayload))).rejects.toThrow("SOURCE_RESTRICTED");
    expect(f.modelChat).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("passes the current-target send callback, exact operation id and input receipt to the locked writer", async () => {
    job("crm-drip-followup", leadPayload);
    await runCrmDripFollowupAgent(params(leadPayload));
    expect(f.record.mock.calls[0][3]).toEqual(expect.objectContaining({ operationId: "job", expectedFollowUpNumber: 1, actor: expect.objectContaining({ kind: "agent" }) }));
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ to: "lead@synthetic.test", idempotencyKey: "crm-drip/job" }));
  });
  it("does not send a draft whose source changed during generation", async () => {
    job("crm-drip-followup", leadPayload); f.modelChat.mockImplementation(async () => { f.revoked = true; return { content: "A stale draft" }; });
    await expect(runCrmDripFollowupAgent(params(leadPayload))).rejects.toThrow("SOURCE_RESTRICTED");
    expect(f.record).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
});
