import type { ModelAttemptGuard } from "@corgtex/models";
import { installSourcePermissionEpochFixture } from "../../../domain/src/source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument, sharedEnv, domainExports } from "./model-consumer.test-fixture";
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: sharedEnv,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("../../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", () => domainExports());
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model", defaultModelGateway: { chat: fixture.chat } }));
import { readableArtifactIds } from "../../../domain/src/source-lineage";
beforeEach(resetFixture);
import { runInboxTriageAgent } from "./inbox-triage";

async function seedCounts() {
  const document = fixture.add("document", { id: "finance-doc", workspaceId, title: "Finance input", textContent: "Private finance body", accessDomain: "FINANCE", archivedAt: null });
  await knownCopiedDocument(document);
  const action = fixture.add("action", { id: "action-public", workspaceId, title: "Public action", bodyMd: "Public body", status: "OPEN", isPrivate: false, archivedAt: null, authorUserId: "beta" });
  await known("Action", action);
  await known("Action", fixture.add("action", { ...action, id: "action-restricted" }), [{ kind: "Document", id: document.id }]);
  fixture.add("action", { ...action, id: "action-legacy" });
  fixture.add("action", { ...action, id: "action-foreign", workspaceId: "ws-b" });
  fixture.add("action", { ...action, id: "action-archived", archivedAt: new Date() });
  const tension = fixture.add("tension", { id: "tension-public", workspaceId, title: "Public tension", bodyMd: "Public tension body", status: "OPEN", archivedAt: null, isPrivate: false, authorUserId: "beta" });
  await known("Tension", tension);
  const proposal = fixture.add("proposal", { id: "proposal-public", workspaceId, title: "Public proposal", bodyMd: "Public proposal body", status: "OPEN", archivedAt: null, isPrivate: false, authorUserId: "beta" });
  await known("Proposal", proposal);
  return { action, document };
}
describe("Inbox triage actual runtime receipts", () => {
  it("gates full records before counts and certifies context/model/run with every consumed input", async () => {
    await seedCounts();
    const identity = fixture.add("agentIdentity", { id: "triage-behavior", workspaceId, agentKey: "inbox-triage", memberType: "INTERNAL", displayName: "Triage", behaviorMd: "Known operator policy", purposeMd: null, isActive: true, archivedAt: null });
    await known("AgentIdentity", identity);
    const run = await runInboxTriageAgent({ workspaceId, triggerRef: "synthetic-trigger", lineageActor: alpha }) as any;
    expect(run).toMatchObject({ status: "COMPLETED", resultJson: { metrics: { openActions: 1, openTensions: 1, submittedProposals: 1 } } });
    expect(fixture.chat.mock.calls[0][0].messages[0].content).toContain("Known operator policy");
    expect(JSON.parse(fixture.chat.mock.calls[0][0].messages[1].content)).toEqual({ openActions: 1, openTensions: 1, submittedProposals: 1 });
    expect(fixture.prisma.action.count).not.toHaveBeenCalled();
    for (const [kind, rows] of [["AgentRun", [run]], ["AgentStep", fixture.rows.agentStep], ["AgentToolCall", fixture.rows.agentToolCall]] as const) {
      expect(await readableArtifactIds(alpha, workspaceId, kind, [...rows])).toEqual(new Set(rows.map((row: any) => row.id)));
      expect(rows.every((row: any) => fixture.manifest(kind, row.id).origin === "DERIVED")).toBe(true);
    }
    expect([...fixture.sources("AgentRun", run.id)]).toEqual(expect.arrayContaining(["Workspace:ws-a", "Action:action-public", "Tension:tension-public", "Proposal:proposal-public", "AgentIdentity:triage-behavior"]));
    expect(fixture.sources("AgentRun", run.id).has("Document:finance-doc")).toBe(false);
  });
  it("includes private transitive sources for an entitled actor and revokes every derived result live", async () => {
    await seedCounts();
    const run = await runInboxTriageAgent({ workspaceId, triggerRef: "beta-trigger", lineageActor: beta }) as any;
    expect(run.resultJson.metrics.openActions).toBe(2);
    expect(fixture.sources("AgentRun", run.id).has("Document:finance-doc")).toBe(true);
    fixture.domains.set("beta", ["WORKSPACE"]);
    expect(await readableArtifactIds(beta, workspaceId, "AgentRun", [run])).toEqual(new Set());
    expect(await readableArtifactIds(beta, workspaceId, "AgentToolCall", fixture.rows.agentToolCall)).toEqual(new Set());
  });
  it("rejects a source edit during the model call and never certifies the stale output", async () => {
    const { action } = await seedCounts();
    fixture.chat.mockImplementation(async () => { action.bodyMd = "Edited after prompt capture"; return { content: "Stale generated summary", usage: { model: "synthetic", inputTokens: 2, outputTokens: 3 } }; });
    await expect(runInboxTriageAgent({ workspaceId, triggerRef: "changed-trigger", lineageActor: alpha })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const run = fixture.rows.agentRun[0];
    expect(run.status).toBe("FAILED");
    expect(fixture.manifest("AgentRun", run.id).origin).toBe("UNKNOWN");
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [run])).toEqual(new Set());
    expect(JSON.stringify(run.resultJson)).not.toContain("Stale generated summary");
  });
  it("produces proven empty counts and denies a foreign workspace before model execution", async () => {
    const run = await runInboxTriageAgent({ workspaceId, triggerRef: "empty-trigger", lineageActor: alpha }) as any;
    expect(run).toMatchObject({ status: "COMPLETED", resultJson: { metrics: { openActions: 0, openTensions: 0, submittedProposals: 0 } } });
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [run])).toEqual(new Set([run.id]));
    await expect(runInboxTriageAgent({ workspaceId: "ws-b", triggerRef: "foreign-trigger", lineageActor: alpha })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.chat).toHaveBeenCalledTimes(1);
  });
});

describe("receipt-backed model provider attempts", () => {
  it.each(["credentials", "retry"].flatMap(boundary => ["input", "caller"].map(authority => ({boundary, authority}))))(
    "denies $authority revoke/restore during $boundary before another provider send", async ({boundary, authority}) => {
      await seedCounts(); const epochs = installSourcePermissionEpochFixture(fixture.prisma); let sends = 0;
      fixture.chat.mockImplementationOnce(async ({authorizeAttempt, signal}: {authorizeAttempt?: ModelAttemptGuard; signal?: AbortSignal}) => {
        const attempt = {signal: signal ?? new AbortController().signal};
        if (boundary === "retry") { await authorizeAttempt?.(attempt); sends++; }
        const kind = authority === "input" ? "Action" : "MemberUserPolicy";
        const id = authority === "input" ? "action-public" : "alpha";
        epochs.bump(workspaceId, kind, id); epochs.bump(workspaceId, kind, id);
        await authorizeAttempt?.(attempt); sends++;
        return {content: "Should never release", usage: {model: "synthetic", inputTokens: 1, outputTokens: 1}};
      });
      await runInboxTriageAgent({workspaceId, triggerRef: "attempt-test", lineageActor: alpha}).catch(() => undefined);
      expect(sends).toBe(boundary === "retry" ? 1 : 0);
      expect(fixture.rows.agentRun[0].status).toBe("FAILED");
    });
  it.each([1, 2])("allows %s current authorized attempt(s) through the real receipt evaluator", async attempts => {
    await seedCounts(); installSourcePermissionEpochFixture(fixture.prisma); let sends = 0;
    fixture.chat.mockImplementationOnce(async ({authorizeAttempt, signal}: {authorizeAttempt: ModelAttemptGuard; signal: AbortSignal}) => {
      expect(authorizeAttempt).toBeTypeOf("function"); expect(signal).toBeInstanceOf(AbortSignal);
      for (let i = 0; i < attempts; i++) { await authorizeAttempt({signal}); sends++; }
      return {content: "Proven summary", usage: {model: "synthetic", inputTokens: 1, outputTokens: 1}};
    });
    const result = await runInboxTriageAgent({workspaceId, triggerRef: "positive-attempt", lineageActor: alpha}) as any;
    expect(result.status).toBe("COMPLETED"); expect(sends).toBe(attempts);
  });
});

async function exerciseReceiptOperation(work: (operation: import("../runtime").AgentOperationContext) => Promise<unknown>) {
  const {executeAgentRun} = await import("../runtime");
  const {captureArtifactInputProof} = await import("../../../domain/src/source-lineage");
  const roots = await captureArtifactInputProof(alpha, workspaceId, [{kind: "Workspace", id: workspaceId}]);
  return executeAgentRun({agentKey: "inbox-triage", workspaceId, triggerType: "EVENT", triggerRef: "composed-attempt",
    goal: "Synthetic test", payload: {}, plan: ["model"], lineageActor: alpha, lineageRoots: roots,
    contextLineageRoots: () => roots, buildContext: async () => ({}),
    execute: async (_context, helpers) => {
      const receipt = await helpers.captureInputs(roots);
      await helpers.tool("model.test", {}, work, {receipt});
      return {resultJson: {done: true}, lineageReceipt: receipt};
    },
  });
}

describe("receipt model request composition", () => {
  it("forwards the exact gateway context to the prior guard before checking original authority", async () => {
    const epochs = installSourcePermissionEpochFixture(fixture.prisma);
    const context = {signal: new AbortController().signal};
    const upstream = vi.fn(async (actual: Parameters<ModelAttemptGuard>[0]) => {
      expect(actual).toBe(context);
      epochs.bump(workspaceId, "MemberUserPolicy", "alpha");
      epochs.bump(workspaceId, "MemberUserPolicy", "alpha");
    });
    await expect(exerciseReceiptOperation(async operation => {
      const request = operation.modelRequest({authorizeAttempt: upstream, marker: "retained"});
      expect(request.marker).toBe("retained");
      // Even an adapter swallowing the authorization error cannot release output.
      await expect(request.authorizeAttempt!(context)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(request.signal?.aborted).toBe(true);
      return "Swallowed denial";
    })).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("preserves a prior guard failure and never permits a later retry", async () => {
    const failure = new Error("Synthetic upstream denial");
    const upstream = vi.fn(async () => {throw failure;});
    await expect(exerciseReceiptOperation(async operation => {
      const request = operation.modelRequest({authorizeAttempt: upstream});
      const context = {signal: new AbortController().signal};
      await expect(request.authorizeAttempt!(context)).rejects.toBe(failure);
      await expect(request.authorizeAttempt!(context)).rejects.toBe(failure);
      return "Swallowed failure";
    })).rejects.toBe(failure);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["caller-before", "deadline-before", "deadline-during", "caller-without-guard"])("preserves %s cancellation", async boundary => {
    const caller = new AbortController(), deadline = new AbortController();
    const failure = new Error("Synthetic cancellation");
    const upstream = vi.fn(async () => { if (boundary === "deadline-during") deadline.abort(failure); });
    await expect(exerciseReceiptOperation(async operation => {
      const request = operation.modelRequest({signal: caller.signal, authorizeAttempt: upstream});
      if (boundary.startsWith("caller")) caller.abort(failure);
      if (boundary === "deadline-before") deadline.abort(failure);
      if (boundary !== "caller-without-guard") await expect(request.authorizeAttempt!({signal: deadline.signal})).rejects.toBe(failure);
      return "Adapter ignored cancellation";
    })).rejects.toBe(failure);
    expect(upstream).toHaveBeenCalledTimes(boundary === "deadline-during" ? 1 : 0);
  });
});
