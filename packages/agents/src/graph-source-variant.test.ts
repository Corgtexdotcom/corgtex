import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGraphSourceVariantJob } from "./graph-source-variant";
const { generate, extract } = vi.hoisted(() => ({ generate: vi.fn(), extract: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ generateGraphSourceVariant: generate, GRAPH_SOURCE_VARIANT_INSTRUCTION: "fixture fixed instruction",
  GRAPH_VARIANT_OBJECT_TYPES: ["Goal"], GRAPH_VARIANT_RELATIONSHIP_TYPES: ["supports"] }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract }, resolveModel: vi.fn(() => "fixture-model") }));
beforeEach(() => {
  vi.clearAllMocks();
  extract.mockResolvedValue({ output: { objects: [{ ref: "new", objectType: "Goal", title: "Supported" }], relationships: [], evidenceRefs: [] } });
  generate.mockImplementation(async ({ generate: callback }) => callback([{ kind: "Document", id: "doc", title: "Safe original",
    content: "Permitted facts", ingestionGuidanceMd: null, oldGraphTitle: "SECRET", storageKey: "SECRET" }], [], { kind: "default", mapKey: "critical-path" }));
});
describe("graph source variant closed model adapter", () => {
  const lease = { workspaceId: "ws", jobId: "job", expectedAttempt: 4, expectedOwner: "worker" };
  it("passes actual worker lease and only explicit current permitted input projections", async () => {
    const result = await runGraphSourceVariantJob(lease);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining(lease));
    const call = extract.mock.calls[0][0];
    expect(call).toMatchObject({ instruction: "fixture fixed instruction", workflowJobId: "job", workspaceId: "ws" });
    expect(JSON.parse(call.input)).toEqual({ scope: { kind: "default", mapKey: "critical-path" },
      sources: [{ kind: "Document", id: "doc", title: "Safe original", content: "Permitted facts", ingestionGuidanceMd: null }] });
    expect(call.input).not.toContain("SECRET");
    expect(result).toEqual(expect.objectContaining({ objects: [expect.objectContaining({ ref: "new" })] }));
  });
  it("does not prompt target/view identity or unrelated metadata, and bounds body text", async () => {
    generate.mockImplementation(async ({ generate: callback }) => callback([{ kind: "ConversationPromptInput", id: "prompt",
      title: null, content: "x".repeat(20000), ingestionGuidanceMd: "g".repeat(8000), ownerId: "SECRET" }], [], { kind: "view", mapViewId: "SECRET" }));
    await runGraphSourceVariantJob(lease);
    const input = JSON.parse(extract.mock.calls[0][0].input);
    expect(input.scope).toEqual({ kind: "view" });
    expect(input.sources[0].content).toHaveLength(12000);
    expect(input.sources[0].ingestionGuidanceMd).toHaveLength(4000);
    expect(JSON.stringify(input)).not.toContain("SECRET");
  });
  it("passes malformed model output to the domain validator without invented fallback graph", async () => {
    extract.mockResolvedValue({ output: null });
    expect(await runGraphSourceVariantJob(lease)).toBeNull();
  });
});

  it("forwards the exact domain attempt guard and cancellation signal", async () => {
    const controls = { signal: new AbortController().signal, authorizeAttempt: vi.fn(async (_context: Readonly<{ signal: AbortSignal }>) => {}) };
    generate.mockImplementation(async ({ generate: callback }) => callback([{ kind: "Document", id: "doc", title: "Public", content: "Facts", ingestionGuidanceMd: null }], [], { kind: "default", mapKey: "critical-path" }, controls));
    await runGraphSourceVariantJob({ workspaceId: "ws", jobId: "job", expectedAttempt: 1, expectedOwner: "worker" });
    const request = extract.mock.calls[0][0];
    expect(request.signal).toBe(controls.signal);
    expect(request.authorizeAttempt).toBe(controls.authorizeAttempt);
    const context = { signal: new AbortController().signal };
    await request.authorizeAttempt(context);
    expect(controls.authorizeAttempt).toHaveBeenCalledWith(context);
  });
