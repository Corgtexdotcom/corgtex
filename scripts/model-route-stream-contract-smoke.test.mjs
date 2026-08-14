import { describe, expect, it, vi } from "vitest";
import { guardOneProviderRequest, runContractSmoke, smokeConfig } from "./model-route-stream-contract-smoke.mjs";
const source = {
  MODEL_ROUTE_STREAM_SMOKE_CONFIRM_ONE_PAID_REQUEST: "1",
  MODEL_ROUTE_STREAM_SMOKE_WORKSPACE_ID: "ws-validation",
  MODEL_PROVIDER: "openrouter",
  MODEL_CHAT_CONVERSATION: "test-model",
};
describe("model route stream contract smoke", () => {
  it("requires explicit paid, workspace, and artifact gates", () => {
    expect(() => smokeConfig({}, [])).toThrow(/acknowledgement/);
    expect(() => smokeConfig(source, ["--out=unsafe.json"])).toThrow(/artifact directory/);
  });
  it("fails before a second provider request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    const guard = guardOneProviderRequest(fetchMock);
    await guard.guarded("https://model.test/chat/completions", {});
    await expect(guard.guarded("https://model.test/chat/completions", {})).rejects.toThrow(/limit exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("writes only sanitized proof for one streamed wrapper request", async () => {
    const writeEvidence = vi.fn();
    const gateway = { async *chatEventStream() {
      await fetch("https://model.test/chat/completions", {});
      yield { type: "tool_call_delta", index: 0, idDelta: "call_", nameDelta: "respond_route_", argumentsDelta: '{"answer":"route-' };
      yield { type: "tool_call_delta", index: 0, idDelta: "one", nameDelta: "stream_contract", argumentsDelta: 'stream-contract-ok"}' };
      return { content: "", tool_calls: [{ id: "call_one", type: "function", function: { name: "respond_route_stream_contract", arguments: '{"answer":"route-stream-contract-ok"}' } }], usage: { provider: "hidden", model: "hidden" } };
    } };
    const evidence = await runContractSmoke({
      source, argv: ["--out=.artifacts/model-route-stream-contract/test.json"], gateway,
      findWorkspace: async () => ({ id: "ws-validation", slug: "corgtex-validation" }),
      fetchImpl: vi.fn().mockResolvedValue(new Response("ok")), writeEvidence,
    });
    expect(evidence).toMatchObject({ status: "pass", providerRequestCount: 1, terminalArgumentsValid: true });
    expect(JSON.stringify(evidence)).not.toMatch(/hidden|ws-validation|route-stream-contract-ok/);
    expect(writeEvidence).toHaveBeenCalledOnce();
  });
  it("writes fixed safe failure diagnostics without raw errors", async () => {
    const writeEvidence = vi.fn();
    const gateway = { async *chatEventStream() { await fetch("https://model.test/chat/completions", {}); throw new Error("raw-secret"); } };
    await expect(runContractSmoke({
      source, argv: ["--out=.artifacts/model-route-stream-contract/fail.json"], gateway,
      findWorkspace: async () => ({ id: "ws-validation", slug: "corgtex-validation" }),
      fetchImpl: vi.fn().mockResolvedValue(new Response("ok")), writeEvidence,
    })).rejects.toThrow("contract smoke failed");
    const diagnostic = writeEvidence.mock.calls[0]?.[1];
    expect(diagnostic).toMatchObject({ status: "fail", errorCode: "CONTRACT_SMOKE_FAILED", failurePhase: "provider_stream", providerRequestCount: 1 });
    expect(JSON.stringify(diagnostic)).not.toContain("raw-secret");
  });
  it("rejects unsafe provider configuration before any fetch", async () => {
    const writeEvidence = vi.fn(); const fetchImpl = vi.fn();
    await expect(runContractSmoke({ source: { ...source, MODEL_PROVIDER: "fake" }, argv: ["--out=.artifacts/model-route-stream-contract/preflight.json"], fetchImpl, writeEvidence })).rejects.toThrow("contract smoke failed");
    expect(writeEvidence.mock.calls[0]?.[1]).toEqual({ schemaVersion: "model-route-stream-contract/v1", status: "fail", errorCode: "PROVIDER_CONFIGURATION_UNSAFE", failurePhase: "provider_preflight", providerRequestCount: 0 }); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
