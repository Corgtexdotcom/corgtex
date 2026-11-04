import { beforeEach, expect, it, vi } from "vitest";
import { runBrainSourceRegenerationJob } from "./brain-source-regenerate";
const { generate, chat } = vi.hoisted(() => ({ generate: vi.fn(), chat: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ generateBrainSourceRemovalCandidate: generate }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { chat }, resolveModel: () => "fixture-model" }));
beforeEach(() => { vi.clearAllMocks(); chat.mockResolvedValue({ content: "Remaining facts" }); });
it("forwards exact removal attempt controls and only retained source content", async () => {
  const controls = { signal: new AbortController().signal, authorizeAttempt: vi.fn(async (_context: Readonly<{ signal: AbortSignal }>) => {}) };
  generate.mockImplementation(async ({ generate: callback }) => callback({ id: "article", title: "Safe title" },
    [{ id: "remaining", title: "Safe title", content: "Remaining facts" }], controls));
  expect(await runBrainSourceRegenerationJob({ workspaceId: "ws", jobId: "job", expectedAttempt: 1, expectedOwner: "worker" })).toBe("Remaining facts");
  const request = chat.mock.calls[0][0];
  expect(request.signal).toBe(controls.signal);
  expect(request.authorizeAttempt).toBe(controls.authorizeAttempt);
  expect(JSON.parse(request.messages[1].content)).toEqual({ articleTitle: "Safe title",
    sources: [{ id: "remaining", title: "Safe title", content: "Remaining facts" }] });
  const context = { signal: new AbortController().signal };
  await request.authorizeAttempt(context);
  expect(controls.authorizeAttempt).toHaveBeenCalledWith(context);
});
