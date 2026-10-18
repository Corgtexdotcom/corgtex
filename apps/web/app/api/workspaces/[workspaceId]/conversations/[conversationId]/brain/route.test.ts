import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "../../../../../../../../../packages/domain/src/errors";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({exportAnswer: vi.fn(), actor: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({exportConversationAnswerToBrain: mocks.exportAnswer, AppError: (await import("../../../../../../../../../packages/domain/src/errors")).AppError}));
vi.mock("@/lib/auth", () => ({resolveRequestActor: mocks.actor}));
vi.mock("@corgtex/shared/telemetry-node", () => ({captureErrorTelemetry: vi.fn()}));
import { POST } from "./route";
const actor = {kind: "user", user: {id: "authenticated-user"}};
const body = {outputTurnId: "persisted-turn", expectedOutputHash: "a".repeat(64), title: "Chosen answer",
  transcriptMode: "NONE", selectedTurns: [], requestId: "00000000-0000-0000-0000-000000000000"};
const params = {params: Promise.resolve({workspaceId: "route-workspace", conversationId: "route-conversation"})};
const request = (extra = {}) => new NextRequest("http://localhost/api/workspaces/route-workspace/conversations/route-conversation/brain", {
  method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...body, ...extra})});
beforeEach(() => {vi.resetAllMocks(); mocks.actor.mockResolvedValue(actor); mocks.exportAnswer.mockResolvedValue({sourceId: "confirmed-source"});});
it("binds identity and tenant to authentication and routing, ignoring model content and claimed actor", async () => {
  const response = await POST(request({actor: {kind: "user", user: {id: "forged-user"}}, workspaceId: "other-tenant",
    conversationId: "other-conversation", content: "UNCONFIRMED_MODEL_CONTENT", sourceType: "MEETING"}), params);
  expect(response.status).toBe(201);
  expect(mocks.exportAnswer).toHaveBeenCalledWith(actor, {...body, workspaceId: "route-workspace", conversationId: "route-conversation"});
});
it("does not mint output authority before authentication", async () => {
  const failure = new AppError(401, "AUTH_REQUIRED", "Not authenticated"); mocks.actor.mockRejectedValue(failure);
  expect((await POST(request(), params)).status).toBe(401);
  expect(mocks.exportAnswer).not.toHaveBeenCalled();
});

it.each([null, [], "text", 7, true, {},
  {...body, outputTurnId: 7}, {...body, expectedOutputHash: null}, {...body, title: []},
  {...body, transcriptMode: "UNKNOWN"}, {...body, requestId: {}},
  {...body, selectedTurns: null}, {...body, selectedTurns: {}}, {...body, selectedTurns: [null]},
  {...body, selectedTurns: ["turn"]}, {...body, selectedTurns: [{id: 3, hash: "a"}]},
  {...body, selectedTurns: [{id: "turn", hash: []}]}])("rejects malformed export shape before domain work: %j", async value => {
  const req = new NextRequest("http://localhost/export", {method: "POST", body: JSON.stringify(value)});
  const response = await POST(req, params);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error: {code: "VALIDATION_ERROR"}});
  expect(mocks.exportAnswer).not.toHaveBeenCalled();
});
it("rejects malformed JSON before domain work", async () => {
  const response = await POST(new NextRequest("http://localhost/export", {method: "POST", body: "{"}), params);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error: {code: "VALIDATION_ERROR"}});
  expect(mocks.exportAnswer).not.toHaveBeenCalled();
});
it.each(["NONE", "PARTIAL", "FULL"])("preserves the explicit %s transcript choice and selected hashes", async transcriptMode => {
  const selectedTurns = transcriptMode === "NONE" ? [] : [{id: "private-prompt-turn", hash: "b".repeat(64)}];
  const response = await POST(request({transcriptMode, selectedTurns}), params);
  expect(response.status).toBe(201);
  expect(mocks.exportAnswer).toHaveBeenCalledWith(actor, {...body, transcriptMode, selectedTurns,
    workspaceId: "route-workspace", conversationId: "route-conversation"});
});
it.each([
  {code: "INVALID_INPUT", status: 400, extra: {transcriptMode: "NONE", selectedTurns: [{id: "turn", hash: "invalid"}]}},
  {code: "BRAIN_EXPORT_LIMIT", status: 413, extra: {transcriptMode: "FULL", selectedTurns: [{id: "turn", hash: "a".repeat(64)}]}},
  {code: "SOURCE_CHANGED", status: 409, extra: {}},
  {code: "BRAIN_CONSENT_REQUIRED", status: 403, extra: {}}
])("preserves domain rejection $code after structural validation", async ({code, status, extra}) => {
  mocks.exportAnswer.mockRejectedValue(new AppError(status, code, "Domain decision"));
  const response = await POST(request(extra), params);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({error: {code}});
  expect(mocks.exportAnswer).toHaveBeenCalledOnce();
});
