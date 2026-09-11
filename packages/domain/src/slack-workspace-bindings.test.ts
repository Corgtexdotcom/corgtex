import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@corgtex/shared", async () => ({ env: (await import("../../shared/src/env")).env }));
import { getSlackWorkspaceBinding, requireSlackWorkspaceBinding, slackWorkspaceBindingsEnabled } from "./slack-workspace-bindings";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const entry = (index = 0) => ({ teamId: `TTEST${index}`, appId: `ATEST${index}`, clientId: `123.${index}`, clientSecret: `synthetic-client-${index}`, signingSecret: `synthetic-signing-${index}`, scopes: ["commands", "chat:write", "channels:history"] });
const configure = (value: unknown) => vi.stubEnv("SLACK_WORKSPACE_BINDINGS_JSON", JSON.stringify(value));
beforeEach(() => {
  vi.stubEnv("SLACK_WORKSPACE_BINDINGS_JSON", undefined);
  vi.stubEnv("SLACK_CLIENT_ID", "legacy-client");
  vi.stubEnv("SLACK_CLIENT_SECRET", "legacy-secret");
  vi.stubEnv("SLACK_SIGNING_SECRET", "legacy-signing");
  vi.stubEnv("SLACK_APP_ID", "ALEGACY");
});
afterEach(() => vi.unstubAllEnvs());

describe("Slack workspace bindings", () => {
  it("selects each original app and exact explicit scopes without global fallback or added permissions", () => {
    configure(Object.fromEntries(ids.map((id, i) => [id, entry(i)])));
    expect(slackWorkspaceBindingsEnabled()).toBe(true);
    ids.forEach((id, i) => expect(requireSlackWorkspaceBinding(id)).toEqual({ ...entry(i), workspaceId: id, source: "workspace" }));
    expect(requireSlackWorkspaceBinding(ids[0]).scopes).not.toContain("channels:join");
  });
  it("fails closed for unscoped, unknown and inherited keys even with complete globals", () => {
    configure({ [ids[0]]: entry() });
    for (const id of [undefined, ids[1], "toString", "__proto__"]) {
      expect(getSlackWorkspaceBinding(id)).toBeNull();
      expect(() => requireSlackWorkspaceBinding(id)).toThrow(expect.objectContaining({ status: 503, code: "SLACK_NOT_CONFIGURED" }));
    }
  });
  it.each(["", " ", "null", "[]", "{}", "{broken"])("rejects configured malformed map %j", (raw) => {
    vi.stubEnv("SLACK_WORKSPACE_BINDINGS_JSON", raw);
    expect(slackWorkspaceBindingsEnabled()).toBe(true);
    expect(() => getSlackWorkspaceBinding(ids[0])).toThrow(expect.objectContaining({ status: 503, code: "SLACK_WORKSPACE_BINDINGS_INVALID" }));
  });
  it.each([
    { unknown: entry() }, { [ids[0]]: null },
    { [ids[0]]: { ...entry(), signingSecret: " " } },
    { [ids[0]]: { ...entry(), clientSecret: null } },
    { [ids[0]]: { ...entry(), clientId: " " } },
    { [ids[0]]: { ...entry(), appId: "TWRONG" } },
    { [ids[0]]: { ...entry(), teamId: "https://evil.example" } },
    { [ids[0]]: { ...entry(), scopes: [] } },
    { [ids[0]]: { ...entry(), scopes: ["commands", "commands"] } },
    { [ids[0]]: { ...entry(), scopes: ["chat:write,channels:join"] } },
    { [ids[0]]: { ...entry(), extra: "synthetic-secret-canary" } },
  ])("rejects invalid entries with safe errors", (value) => {
    configure(value);
    let error: unknown;
    try { getSlackWorkspaceBinding(ids[0]); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 503, code: "SLACK_WORKSPACE_BINDINGS_INVALID" });
    expect(String(error)).not.toMatch(/synthetic|legacy|evil/);
    expect(JSON.stringify(error)).not.toMatch(/synthetic|legacy|evil/);
  });
  it("validates every entry and reads fresh configuration after an operator change", () => {
    configure({ [ids[0]]: entry(), [ids[1]]: { ...entry(1), scopes: null } });
    expect(() => getSlackWorkspaceBinding(ids[0])).toThrow();
    configure({ [ids[0]]: entry() });
    expect(requireSlackWorkspaceBinding(ids[0]).appId).toBe("ATEST0");
    configure({ [ids[1]]: entry(1) });
    expect(getSlackWorkspaceBinding(ids[0])).toBeNull();
    expect(requireSlackWorkspaceBinding(ids[1]).appId).toBe("ATEST1");
  });
  it("preserves credential bytes and isolates returned scope arrays", () => {
    configure({ [ids[0]]: { ...entry(), signingSecret: " synthetic-signing " } });
    const binding = requireSlackWorkspaceBinding(ids[0]);
    expect(binding.signingSecret).toBe(" synthetic-signing ");
    binding.scopes!.push("channels:join");
    expect(requireSlackWorkspaceBinding(ids[0]).scopes).toEqual(entry().scopes);
  });
  it("retains legacy configuration only when map is absent", () => {
    expect(slackWorkspaceBindingsEnabled()).toBe(false);
    expect(requireSlackWorkspaceBinding(ids[0])).toEqual({ source: "legacy", teamId: null, appId: "ALEGACY", clientId: "legacy-client", clientSecret: "legacy-secret", signingSecret: "legacy-signing", scopes: null });
    vi.stubEnv("SLACK_SIGNING_SECRET", undefined);
    expect(getSlackWorkspaceBinding()).toMatchObject({ signingSecret: null, clientId: "legacy-client" });
    expect(() => requireSlackWorkspaceBinding()).toThrow(expect.objectContaining({ status: 503 }));
    for (const key of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_APP_ID"]) vi.stubEnv(key, undefined);
    expect(getSlackWorkspaceBinding()).toBeNull();
  });
});
