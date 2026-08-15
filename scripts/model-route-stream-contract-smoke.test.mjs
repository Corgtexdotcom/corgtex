import { describe, expect, it, vi } from "vitest"; import { guardOneProviderRequest, runContractSmoke, smokeConfig } from "./model-route-stream-contract-smoke.mjs";
const source = { MODEL_ROUTE_STREAM_SMOKE_CONFIRM_ONE_PAID_REQUEST: "1", MODEL_ROUTE_STREAM_SMOKE_WORKSPACE_ID: "ws-validation", MODEL_PROVIDER: "openrouter", MODEL_CHAT_CONVERSATION: "test-model", MODEL_API_KEY: "test-key" };
const workspace = { id: "ws-validation", slug: "corgtex-validation", plan: "ENTERPRISE_MANAGED", modelUsageBudget: null };
describe("model route stream contract smoke", () => {
  it("requires explicit paid, workspace, and artifact gates", () => { expect(() => smokeConfig({}, [])).toThrow(/acknowledgement/); expect(() => smokeConfig(source, ["--out=unsafe.json"])).toThrow(/artifact directory/); });
  it("fails before a second provider request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok")); const guard = guardOneProviderRequest(fetchMock); await guard.guarded("https://model.test/chat/completions", {});
    await expect(guard.guarded("https://model.test/chat/completions", {})).rejects.toThrow(/limit exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(1); });
  it("writes only sanitized proof for one streamed wrapper request", async () => {
    const writeEvidence = vi.fn(); const gateway = { async *chatEventStream() {
      await fetch("https://model.test/chat/completions", {}); yield { type: "tool_call_delta", index: 0, idDelta: "call_", nameDelta: "respond_route_", argumentsDelta: '{"answer":"route-' };
      yield { type: "tool_call_delta", index: 0, idDelta: "one", nameDelta: "stream_contract", argumentsDelta: 'stream-contract-ok"}' };
      return { content: "", tool_calls: [{ id: "call_one", type: "function", function: { name: "respond_route_stream_contract", arguments: '{"answer":"route-stream-contract-ok"}' } }], usage: { provider: "hidden", model: "hidden" } };
    } };
    const evidence = await runContractSmoke({ source, argv: ["--out=.artifacts/model-route-stream-contract/test.json"], gateway, findWorkspace: async () => workspace, fetchImpl: vi.fn().mockResolvedValue(new Response("ok")), writeEvidence });
    expect(evidence).toMatchObject({ status: "pass", providerRequestCount: 1, terminalArgumentsValid: true }); expect(JSON.stringify(evidence)).not.toMatch(/hidden|ws-validation|route-stream-contract-ok/); expect(writeEvidence).toHaveBeenCalledOnce();
  });
  it.each([["gateway_preparation", { async *chatEventStream() { throw new Error("raw-secret"); } }, 0, "GATEWAY_PREPARATION_FAILED"], ["provider_stream", { async *chatEventStream() { await fetch("https://model.test/chat/completions", {}); throw new Error("raw-secret"); } }, 1, "CONTRACT_SMOKE_FAILED"]])("writes fixed safe %s diagnostics", async (failurePhase, gateway, providerRequestCount, errorCode) => {
    const writeEvidence = vi.fn(); await expect(runContractSmoke({ source, argv: ["--out=.artifacts/model-route-stream-contract/fail.json"], gateway, findWorkspace: async () => workspace, fetchImpl: vi.fn().mockResolvedValue(new Response("ok")), writeEvidence })).rejects.toThrow("contract smoke failed"); const diagnostic = writeEvidence.mock.calls[0]?.[1];
    expect(diagnostic).toMatchObject({ status: "fail", errorCode, failurePhase, providerRequestCount }); expect(JSON.stringify(diagnostic)).not.toContain("raw-secret");
  });
  it("rejects a missing provider credential before any fetch", async () => {
    const writeEvidence = vi.fn(); const fetchImpl = vi.fn();
    await expect(runContractSmoke({ source: { ...source, MODEL_API_KEY: "" }, argv: ["--out=.artifacts/model-route-stream-contract/preflight.json"], fetchImpl, writeEvidence })).rejects.toThrow("contract smoke failed");
    expect(writeEvidence.mock.calls[0]?.[1]).toEqual({ schemaVersion: "model-route-stream-contract/v1", status: "fail", errorCode: "PROVIDER_CONFIGURATION_UNSAFE", failurePhase: "provider_preflight", providerRequestCount: 0 }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("uses one local preflight boundary without provider or usage residue", async () => {
    const writeEvidence = vi.fn(); const fetchImpl = vi.fn(); const countResidue = vi.fn().mockResolvedValueOnce([1, 7, 4]).mockResolvedValueOnce([1, 7, 4]);
    const gateway = { async *chatEventStream() { const response = await fetch("https://model.test/chat/completions", {}); if (!response.ok) throw new Error("expected local refusal"); return undefined; } };
    const evidence = await runContractSmoke({ source: { ...source, MODEL_ROUTE_STREAM_SMOKE_CONFIRM_ONE_PAID_REQUEST: undefined }, argv: ["--preflight-only", "--out=.artifacts/model-route-stream-contract/preflight.json"], gateway, findWorkspace: async () => workspace, countResidue, fetchImpl, writeEvidence });
    expect(evidence).toEqual({ schemaVersion: "model-route-stream-contract/v1", status: "pass", mode: "preflight-only", providerRequestCount: 0, localFetchBoundaryCount: 1, workspaceRowDelta: 0, usageRowDelta: 0, ledgerRowDelta: 0 }); expect(fetchImpl).not.toHaveBeenCalled(); expect(countResidue).toHaveBeenCalledTimes(2); expect(JSON.stringify(evidence)).not.toMatch(/ws-validation|test-key|test-model/);
    const changed = vi.fn().mockResolvedValueOnce([1, 7, 4]).mockResolvedValueOnce([1, 8, 4]); await expect(runContractSmoke({ source, argv: ["--preflight-only", "--out=.artifacts/model-route-stream-contract/changed.json"], gateway, findWorkspace: async () => workspace, countResidue: changed, fetchImpl, writeEvidence })).rejects.toThrow("contract smoke failed"); expect(writeEvidence.mock.calls.at(-1)?.[1]).toMatchObject({ status: "fail", providerRequestCount: 0, localFetchBoundaryCount: 1 });
  });
  it.each([[{ id: "customer", slug: "customer", plan: "ENTERPRISE_MANAGED", modelUsageBudget: null }, "customer"], [{ ...workspace, plan: "PAYG_AI" }, "non-enterprise"], [{ ...workspace, modelUsageBudget: { id: "cap" } }, "budgeted"]])("rejects an unsafe %s workspace before fetch", async (unsafeWorkspace) => {
    const writeEvidence = vi.fn(); const fetchImpl = vi.fn(); vi.stubEnv("PRODUCTION_VALIDATION_ALLOW_CUSTOMER_WRITES", "1"); await expect(runContractSmoke({ source, argv: ["--out=.artifacts/model-route-stream-contract/customer.json"], findWorkspace: async () => unsafeWorkspace, fetchImpl, writeEvidence })).rejects.toThrow("contract smoke failed"); expect(writeEvidence.mock.calls[0]?.[1]).toMatchObject({ status: "fail", failurePhase: "workspace_validation", providerRequestCount: 0 }); expect(fetchImpl).not.toHaveBeenCalled(); vi.unstubAllEnvs();
  });
});
