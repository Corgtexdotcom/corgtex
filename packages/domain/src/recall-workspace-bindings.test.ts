import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@corgtex/shared", async () => {
  const { env } = await import("../../shared/src/env");
  return { env };
});
import {
  getRecallWorkspaceBinding,
  recallWorkspaceBindingsEnabled,
  requireRecallWorkspaceBinding,
} from "./recall-workspace-bindings";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const entry = (index = 0) => ({
  apiKey: `synthetic-api-${index}`,
  webhookSecret: `synthetic-webhook-${index}`,
  region: "us-east-1",
  providerWorkspaceId: `synthetic-provider-${index}`,
});
const configure = (value: unknown) => vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", JSON.stringify(value));

beforeEach(() => {
  vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", undefined);
  vi.stubEnv("RECALL_API_KEY", "legacy-api");
  vi.stubEnv("RECALL_WEBHOOK_SECRET", "legacy-webhook");
  vi.stubEnv("RECALL_REGION", "us-west-2");
});
afterEach(() => vi.unstubAllEnvs());

describe("Recall workspace bindings", () => {
  it("resolves three isolated provider bindings without using global credentials", () => {
    configure(Object.fromEntries(ids.map((id, index) => [id, entry(index)])));
    expect(recallWorkspaceBindingsEnabled()).toBe(true);
    ids.forEach((id, index) => {
      expect(requireRecallWorkspaceBinding(id)).toEqual({ ...entry(index), workspaceId: id, source: "workspace" });
    });
  });

  it("fails closed for missing, unknown and inherited workspace names", () => {
    configure({ [ids[0]]: entry() });
    for (const id of [undefined, ids[1], "toString", "__proto__", ids[0].toUpperCase().replace("1111", "ABCD")]) {
      expect(getRecallWorkspaceBinding(id)).toBeNull();
      expect(() => requireRecallWorkspaceBinding(id)).toThrow(expect.objectContaining({ status: 503, code: "RECORDER_VENDOR_NOT_CONFIGURED" }));
    }
  });

  it.each(["", " ", "{broken", "null", "[]", "{}"])("does not fall back for invalid configured JSON %j", (raw) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", raw);
    expect(recallWorkspaceBindingsEnabled()).toBe(true);
    expect(() => getRecallWorkspaceBinding(ids[0])).toThrow(expect.objectContaining({ status: 503, code: "RECALL_WORKSPACE_BINDINGS_INVALID" }));
  });

  it.each([
    { not_a_uuid: entry() },
    { [ids[0]]: null },
    { [ids[0]]: { ...entry(), apiKey: " " } },
    { [ids[0]]: { ...entry(), webhookSecret: null } },
    { [ids[0]]: { ...entry(), providerWorkspaceId: "" } },
    { [ids[0]]: { ...entry(), region: "us-east-1.evil.example/" } },
    { [ids[0]]: { ...entry(), region: "us-east-1@evil.example" } },
    { [ids[0]]: { ...entry(), unexpected: "synthetic-secret-canary" } },
  ])("rejects malformed entries without exposing secret values", (value) => {
    configure(value);
    let error: unknown;
    try { getRecallWorkspaceBinding(ids[0]); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 503, code: "RECALL_WORKSPACE_BINDINGS_INVALID" });
    expect(String(error)).not.toMatch(/synthetic|evil|legacy/);
  });

  it("validates the whole map before returning an otherwise valid binding", () => {
    configure({ [ids[0]]: entry(), [ids[1]]: { ...entry(1), region: "../bad" } });
    expect(() => getRecallWorkspaceBinding(ids[0])).toThrow(expect.objectContaining({ code: "RECALL_WORKSPACE_BINDINGS_INVALID" }));
  });

  it("accepts region DNS labels and preserves exact credential bytes", () => {
    configure({ [ids[0]]: { ...entry(), region: "ap-northeast-1", apiKey: " Token synthetic " } });
    expect(requireRecallWorkspaceBinding(ids[0]).apiKey).toBe(" Token synthetic ");
    expect(requireRecallWorkspaceBinding(ids[0]).region).toBe("ap-northeast-1");
  });

  it("does not retain a stale parsed binding when operator configuration changes", () => {
    configure({ [ids[0]]: entry() });
    expect(requireRecallWorkspaceBinding(ids[0]).apiKey).toBe(entry().apiKey);
    configure({ [ids[1]]: entry(1) });
    expect(getRecallWorkspaceBinding(ids[0])).toBeNull();
    expect(requireRecallWorkspaceBinding(ids[1]).apiKey).toBe(entry(1).apiKey);
  });

  it("preserves legacy API and webhook behavior when no map is configured", () => {
    expect(recallWorkspaceBindingsEnabled()).toBe(false);
    expect(requireRecallWorkspaceBinding()).toEqual({ apiKey: "legacy-api", webhookSecret: "legacy-webhook", region: "us-west-2", providerWorkspaceId: null, source: "legacy" });
    expect(getRecallWorkspaceBinding(ids[0])).toEqual(getRecallWorkspaceBinding());
  });

  it("exposes partial legacy readiness without requiring webhook configuration for API calls", () => {
    vi.stubEnv("RECALL_WEBHOOK_SECRET", undefined);
    expect(requireRecallWorkspaceBinding().webhookSecret).toBeNull();
    vi.stubEnv("RECALL_API_KEY", undefined);
    vi.stubEnv("RECALL_WEBHOOK_SECRET", "legacy-webhook");
    expect(getRecallWorkspaceBinding()).toMatchObject({ apiKey: null, webhookSecret: "legacy-webhook" });
    expect(() => requireRecallWorkspaceBinding()).toThrow(expect.objectContaining({ status: 503 }));
    vi.stubEnv("RECALL_WEBHOOK_SECRET", undefined);
    expect(getRecallWorkspaceBinding()).toBeNull();
  });

  it("rejects an arbitrary legacy region host too", () => {
    vi.stubEnv("RECALL_REGION", "host.example/");
    expect(() => requireRecallWorkspaceBinding()).toThrow(expect.objectContaining({ code: "RECALL_WORKSPACE_BINDINGS_INVALID" }));
  });
});
