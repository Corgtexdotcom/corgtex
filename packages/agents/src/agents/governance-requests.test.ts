import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, resetFixture, known, knownCopiedDocument, sharedEnv, domainExports } from "./model-consumer.test-fixture";
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { ...sharedEnv,
  MODEL_PROVIDER: "openai", MODEL_API_KEY: "synthetic-key", MODEL_BASE_URL: "https://model.example.test/v1",
  MODEL_CHAT_DEFAULT: "synthetic", MODEL_CHAT_FAST: "synthetic", MODEL_CHAT_STANDARD: "synthetic",
  MODEL_CHAT_QUALITY: "synthetic", MODEL_CHAT_EXCELLENT: "synthetic", MODEL_REQUEST_TIMEOUT_MS: 10000,
  MODEL_PROVIDER_ROUTES_JSON: "[]", MODEL_PRICE_OVERRIDES_JSON: "[]", MODEL_OMIT_TEMPERATURE_MODELS: "",
}, toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("../../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user?.id) ?? ["WORKSPACE"] }));
vi.mock("@corgtex/domain", async () => ({ ...await domainExports(),
  ...await import("../../../domain/src/agent-runs"),
  ...await import("../../../domain/src/finance-imports"),
  getCurrentConstitution: async () => fixture.rows.constitution[0] ?? null,
  loadConstitutionCorpusSnapshot: async () => ({ corpus: fixture.rows.policyCorpus, fingerprint: "a".repeat(64) }),
  createConstitutionVersion: async () => ({ id: "new-constitution", version: 2 }),
}));
vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: async (input: { actor: typeof alpha }) => { await captureArtifactInputProof(input.actor, workspaceId, [{ kind: "Workspace", id: workspaceId }]); return []; },
  getKnowledgeSearchInputRoots: async (actor: typeof alpha) => captureArtifactInputProof(actor, workspaceId, [{ kind: "Workspace", id: workspaceId }]),
}));
vi.mock("../../../models/src/usage", () => ({ assertCatalogModelBudget: vi.fn(), assertWorkspaceModelBudget: vi.fn(), recordModelUsage: vi.fn() }));
import { captureArtifactInputProof, readableArtifactIds } from "../../../domain/src/source-lineage";
import { supportsAgentGovernancePrompt, AGENT_REGISTRY, type RegisteredAgentKey } from "../../../domain/src/agent-registry";
import { updateAgentConfig } from "../../../domain/src/agent-config";
import { executeAgentRun } from "../runtime";
import { openAICompatibleModelGateway } from "../../../models/src/openai-compatible-gateway";
import { runInboxTriageAgent } from "./inbox-triage";
import { runProposalDraftingAgent } from "./proposal-drafting";
import { runConstitutionSynthesisAgent } from "./constitution-synthesis";
import { proposeFinanceReportImportV1 } from "../finance-report-import";

const sends = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({
  choices: [{ message: { content: '{"summary":"Synthetic summary"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 },
}));
beforeEach(async () => { await resetFixture(); sends.mockClear(); vi.stubGlobal("fetch", sends); });
afterEach(() => vi.unstubAllGlobals());
async function policy(agentKey = "inbox-triage", proven = true) {
  const row = fixture.add("workspaceAgentConfig", { id: `config-${agentKey}`, workspaceId, agentKey, governancePolicy: "Use approved evidence only." });
  if (proven) await known("WorkspaceAgentGovernance", row, [], alpha);
  return row;
}
async function identity(agentKey: string, text: string) {
  const row = fixture.add("agentIdentity", { id: `identity-${agentKey}`, workspaceId, agentKey,
    displayName: agentKey, memberType: "INTERNAL", behaviorMd: text, isActive: agentKey !== "__workspace__", archivedAt: null });
  await known("AgentIdentity", row, [], alpha);
}
async function request(agentKey: RegisteredAgentKey, mode: "chat" | "extract", beforeAttempt?: () => Promise<void>) {
  const roots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Workspace", id: workspaceId }]);
  return executeAgentRun({ workspaceId, agentKey, triggerType: "MANUAL", triggerRef: "governance-test", goal: "Synthetic request",
    payload: {}, plan: ["model"], lineageActor: alpha, lineageRoots: roots, contextLineageRoots: () => roots,
    buildContext: async () => ({}), execute: async (_context, helpers, runId, model) => {
      const receipt = await helpers.captureInputs(roots);
      const controls = { authorizeAttempt: async () => { await beforeAttempt?.(); } };
      const result = await helpers.tool<unknown>("model.test", {}, operation => mode === "chat"
        ? openAICompatibleModelGateway.chat(operation.modelRequest({ ...controls, workspaceId, agentRunId: runId, model, taskType: "CHAT",
          messages: [{ role: "system", content: `${helpers.behaviorContext ?? ""}\n\nBuilt-in task.` }, { role: "user", content: "Synthetic input" }] }))
        : openAICompatibleModelGateway.extract(operation.modelRequest({ ...controls, workspaceId, agentRunId: runId, model,
          instruction: "Built-in extraction task.", input: "Synthetic input", schemaHint: '{"summary":"string"}' })), { receipt });
      return { lineageReceipt: receipt, resultJson: JSON.parse(JSON.stringify(result)) };
    } });
}
function system() { return JSON.parse(String(sends.mock.calls[0][1]?.body)).messages[0].content as string; }

describe("saved governance at the actual HTTP model boundary", () => {
  it("preserves the absent-policy request", async () => {
    await request("inbox-triage", "chat");
    expect(system()).toBe("\n\nBuilt-in task.");
  });
  const inactiveStates = ["absent", "blank", "archived"] as const;
  async function inactivePolicy(state: typeof inactiveStates[number]) {
    if (state === "absent") return;
    return fixture.add("workspaceAgentConfig", { id: "inactive-config", workspaceId, agentKey: "inbox-triage",
      governancePolicy: state === "blank" ? " \n\t" : "Use approved evidence only.", archivedAt: state === "archived" ? new Date() : null });
  }
  async function activatePolicy(row: Awaited<ReturnType<typeof inactivePolicy>>) {
    if (!row) await policy();
    else {
      Object.assign(row, { governancePolicy: "Use approved evidence only.", archivedAt: null, updatedAt: new Date(row.updatedAt.getTime() + 1) });
      await known("WorkspaceAgentGovernance", row, [], alpha);
    }
  }
  it.each(inactiveStates.flatMap(state => ["chat", "extract"].map(mode => ({ state, mode: mode as "chat" | "extract" }))))(
    "preserves unchanged $state policy for $mode", async ({ state, mode }) => {
      await inactivePolicy(state);
      await request("inbox-triage", mode);
      expect(sends).toHaveBeenCalledOnce();
      expect(system()).not.toContain("Saved Agent Governance");
    });
  it.each(inactiveStates.flatMap(state => ["authorization", "retry"].flatMap(boundary =>
    ["chat", "extract"].map(mode => ({ state, boundary, mode: mode as "chat" | "extract" })))))(
    "rejects $state policy activation during $boundary for $mode", async ({ state, boundary, mode }) => {
      const row = await inactivePolicy(state);
      if (boundary === "retry") sends.mockImplementationOnce(async () => {
        await activatePolicy(row);
        return new Response("retry", { status: 503 });
      });
      await expect(request("inbox-triage", mode, boundary === "authorization" ? () => activatePolicy(row) : undefined)).rejects.toThrow();
      expect(sends).toHaveBeenCalledTimes(boundary === "retry" ? 1 : 0);
    });
  it.each(["blank", "archived"] as const)("rejects %s activation even when its timestamp is unchanged", async state => {
    const row = (await inactivePolicy(state))!;
    await expect(request("inbox-triage", "chat", async () => {
      Object.assign(row, { governancePolicy: "Use approved evidence only.", archivedAt: null });
    })).rejects.toThrow();
    expect(sends).not.toHaveBeenCalled();
  });
  it.each(Object.keys(AGENT_REGISTRY).filter(supportsAgentGovernancePrompt).flatMap(key =>
    ["chat", "extract"].map(mode => ({ agentKey: key as RegisteredAgentKey, mode: mode as "chat" | "extract" }))))(
    "composes proven governance and identities for $agentKey $mode", async ({ agentKey, mode }) => {
      await policy(agentKey); await identity("__workspace__", "Workspace behavior."); await identity(agentKey, "Agent behavior.");
      const result = await request(agentKey, mode) as any;
      expect(result.status).toBe("COMPLETED");
      expect(sends).toHaveBeenCalledOnce();
      expect(system()).toMatch(/^## Saved Agent Governance\n\nUse approved evidence only\./);
      expect(system().split("Use approved evidence only.")).toHaveLength(2);
      {
        expect(system().indexOf("Workspace behavior.")).toBeGreaterThan(system().indexOf("Use approved evidence only."));
        expect(system().indexOf("Agent behavior.")).toBeGreaterThan(system().indexOf("Workspace behavior."));
      }
      expect(fixture.sources("AgentRun", result.id)).toContain(`WorkspaceAgentGovernance:config-${agentKey}`);
      expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [result])).toEqual(new Set([result.id]));
    });
  it("executes the production inbox consumer through the real gateway without duplicated policy", async () => {
    await policy(); await identity("__workspace__", "Workspace behavior."); await identity("inbox-triage", "Agent behavior.");
    await runInboxTriageAgent({ workspaceId, triggerRef: "actual-inbox", lineageActor: alpha });
    expect(sends).toHaveBeenCalledOnce();
    expect(system()).toMatch(/^## Saved Agent Governance/);
    expect(system()).toContain("Summarize the workspace operating state");
    expect(system().split("Use approved evidence only.")).toHaveLength(2);
  });
  it("skips an already archived policy and fences an archive/restore during authorization", async () => {
    const row = await policy(); row.archivedAt = new Date();
    await request("inbox-triage", "chat");
    expect(system()).not.toContain("Use approved evidence only.");
    await resetFixture(); sends.mockClear();
    const restored = await policy();
    await expect(request("inbox-triage", "chat", async () => {
      restored.updatedAt = new Date(restored.updatedAt.getTime() + 1);
    })).rejects.toThrow();
    expect(sends).not.toHaveBeenCalled();
  });
  it("governs both production proposal requests and retains the human approval checkpoint", async () => {
    await policy("proposal-drafting");
    fixture.add("agentRequestInput", { id: "authored-request", workspaceId, userId: "alpha", agentKey: "proposal-drafting", prompt: "Synthetic proposal", meetingId: null, proposalId: null });
    const run = await runProposalDraftingAgent({ workspaceId, triggerRef: "proposal-test", requestInputId: "authored-request" }) as any;
    expect(run.status).toBe("WAITING_APPROVAL");
    expect(sends).toHaveBeenCalledTimes(2);
    for (const [, init] of sends.mock.calls) expect(JSON.parse(String(init?.body)).messages[0].content).toMatch(/^## Saved Agent Governance/);
  });
  it("governs the production constitution synthesis and follow-up diff requests", async () => {
    await policy("constitution-synthesis");
    const parent = fixture.add("proposal", { id: "accepted-policy-proposal", workspaceId, title: "Accepted policy proposal", bodyMd: "Source policy", isPrivate: false, archivedAt: null, status: "APPROVED" });
    await known("Proposal", parent, [], alpha);
    const accepted = fixture.add("policyCorpus", { id: "policy-1", workspaceId, proposalId: parent.id, title: "Accepted policy", bodyMd: "Policy text", acceptedAt: fixture.timestamp });
    await known("PolicyCorpus", accepted, [], alpha);
    const old = fixture.add("constitution", { id: "old-constitution", workspaceId, version: 1, bodyMd: "Previous constitution" });
    await known("Constitution", old, [], alpha);
    const bodyMd = Array.from({ length: 10 }, (_, i) => `## ${i + 1}. Point ${i + 1}\nSupported policy.`).join("\n\n");
    sends.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ bodyMd,
      pointSources: Array.from({ length: 10 }, (_, i) => ({ pointOrder: i + 1, policyCorpusIds: i === 0 ? [accepted.id] : [] })) }) } }], usage: {} }));
    await runConstitutionSynthesisAgent({ workspaceId, triggerRef: "constitution-test", actor: alpha });
    expect(sends).toHaveBeenCalledTimes(2);
    for (const [, init] of sends.mock.calls) expect(JSON.parse(String(init?.body)).messages[0].content).toMatch(/^## Saved Agent Governance/);
  });
  it("retains Finance adapter system guidance through gateway JSON repair and validation repair", async () => {
    sends.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: "invalid json" } }], usage: {} }));
    await proposeFinanceReportImportV1({ workspaceId, format: "PDF", extractedEvidence: JSON.stringify({ page: 1, text: "Synthetic report" }),
      workspaceCurrencyCodes: [], gateway: openAICompatibleModelGateway,
      behaviorContext: "## Saved Agent Governance\n\nUse approved evidence only.", model: "synthetic" });
    expect(sends).toHaveBeenCalledTimes(3);
    for (const [, init] of sends.mock.calls) expect(JSON.parse(String(init?.body)).messages[0].content).toMatch(/^## Saved Agent Governance/);
  });
  it("refuses unknown legacy policy before any HTTP request", async () => {
    await policy("inbox-triage", false);
    await expect(request("inbox-triage", "chat")).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(sends).not.toHaveBeenCalled();
  });
  it.each(["edit", "clear", "delete"])("stops a policy %s during credential/attempt authorization", async change => {
    const row = await policy();
    await expect(request("inbox-triage", "chat", async () => {
      if (change === "delete") fixture.rows.workspaceAgentConfig = [];
      else row.governancePolicy = change === "clear" ? null : "Changed policy.";
    })).rejects.toThrow();
    expect(sends).not.toHaveBeenCalled();
  });
  it("stops retry after a policy edit following the first HTTP request", async () => {
    const row = await policy();
    sends.mockImplementationOnce(async () => { row.governancePolicy = "Replacement policy."; return new Response("retry", { status: 503 }); });
    await expect(request("inbox-triage", "chat")).rejects.toThrow();
    expect(sends).toHaveBeenCalledOnce();
  });
  it("retains source restrictions and revokes governed outputs when a copied policy source is revoked", async () => {
    const document = fixture.add("document", { id: "policy-source", workspaceId, title: "Policy", textContent: "Evidence policy", accessDomain: "WORKSPACE", archivedAt: null });
    await knownCopiedDocument(document, alpha);
    const row = await policy();
    await known("WorkspaceAgentGovernance", row, [{ kind: "Document", id: document.id }], alpha);
    const result = await request("inbox-triage", "chat") as any;
    document.archivedAt = new Date();
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [result])).toEqual(new Set());
    expect(await readableArtifactIds(alpha, workspaceId, "AgentToolCall", fixture.rows.agentToolCall)).toEqual(new Set());
  });
  it("captures a full authenticated human policy replacement atomically with config", async () => {
    const admin = fixture.rows.member.find(row => row.userId === "alpha"); admin.role = "ADMIN";
    await updateAgentConfig(alpha, { workspaceId, agentKey: "inbox-triage", governancePolicy: "Human policy." });
    const row = fixture.rows.workspaceAgentConfig[0];
    expect(fixture.manifest("WorkspaceAgentGovernance", row.id).origin).toBe("HUMAN_ORIGINAL");
    await runInboxTriageAgent({ workspaceId, triggerRef: "saved-policy", lineageActor: alpha });
    expect(system()).toContain("Human policy.");
  });
});
