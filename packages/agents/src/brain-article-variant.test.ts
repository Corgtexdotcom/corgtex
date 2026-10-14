import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBrainArticleVariantJob } from "./brain-article-variant";

const { generateVariant, extract } = vi.hoisted(() => ({ generateVariant: vi.fn(), extract: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ generateBrainArticleVariant: generateVariant }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract }, resolveModel: vi.fn(() => "fixture-model") }));

beforeEach(() => {
  vi.clearAllMocks();
  extract.mockResolvedValue({ output: { title: "Permitted title", bodyMd: "Supported Markdown." } });
  generateVariant.mockImplementation(async ({ generate }) => generate([{ kind: "BrainSource", id: "source-1", title: "Public source",
    content: "Permitted facts", sourceType: "DOCUMENT", tier: 1, ingestionGuidanceMd: null }]));
});

describe("article variant model adapter", () => {
  const lease = { workspaceId: "ws-1", jobId: "job-1", expectedAttempt: 3, expectedOwner: "worker-1" };

  it("passes worker receipt and sends only the admitted source projection to the model", async () => {
    expect(await runBrainArticleVariantJob(lease)).toEqual({ title: "Permitted title", bodyMd: "Supported Markdown." });
    expect(generateVariant).toHaveBeenCalledWith(expect.objectContaining(lease));
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ model: "fixture-model", workspaceId: "ws-1", workflowJobId: "job-1" }));
    const input = JSON.parse(extract.mock.calls[0][0].input);
    expect(input).toEqual({ sources: [{ kind: "BrainSource", id: "source-1", title: "Public source", content: "Permitted facts",
      sourceType: "DOCUMENT", tier: 1, ingestionGuidanceMd: null }] });
    expect(input).not.toHaveProperty("articleTitle");
    expect(input).not.toHaveProperty("currentArticle");
  });

  it("bounds source and guidance prompt text while the service captures complete source proof", async () => {
    generateVariant.mockImplementation(async ({ generate }) => generate([{ kind: "BrainSource", id: "source-1", title: "Title", content: "x".repeat(20_000),
      ingestionGuidanceMd: "g".repeat(8_000), sourceType: "DOCUMENT", tier: 1 }]));
    await runBrainArticleVariantJob(lease);
    const input = JSON.parse(extract.mock.calls[0][0].input);
    expect(input.sources[0].content).toHaveLength(12_000);
    expect(input.sources[0].ingestionGuidanceMd).toHaveLength(4_000);
  });

  it("sends heterogeneous admitted content with explicit kinds and excludes extra metadata", async () => {
    generateVariant.mockImplementation(async ({ generate }) => generate([
      { kind: "Document", id: "doc", title: "Doc", content: "Allowed document facts", ingestionGuidanceMd: null, storageKey: "DO NOT PROMPT", canonicalTitle: "DO NOT PROMPT" },
      { kind: "ConversationPromptInput", id: "prompt", title: null, content: "Owner's permitted request", ingestionGuidanceMd: null, userId: "DO NOT PROMPT" },
    ]));
    await runBrainArticleVariantJob(lease);
    const input = JSON.parse(extract.mock.calls[0][0].input);
    expect(input.sources).toEqual([
      { kind: "Document", id: "doc", title: "Doc", content: "Allowed document facts", ingestionGuidanceMd: null },
      { kind: "ConversationPromptInput", id: "prompt", title: null, content: "Owner's permitted request", ingestionGuidanceMd: null },
    ]);
    expect(JSON.stringify(input)).not.toContain("DO NOT PROMPT");
  });

  it("does not synthesize fallback fields for invalid model output", async () => {
    extract.mockResolvedValue({ output: { title: 123, bodyMd: null } });
    expect(await runBrainArticleVariantJob(lease)).toEqual({ title: "", bodyMd: "" });
  });
});
