import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({exportAnswer: vi.fn(), actor: vi.fn(), error: vi.fn()}));
vi.mock("@corgtex/domain", () => ({exportConversationAnswerToBrain: mocks.exportAnswer}));
vi.mock("@/lib/auth", () => ({resolveRequestActor: mocks.actor}));
vi.mock("@/lib/http", () => ({handleRouteError: mocks.error}));
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
  const failure = new Error("Not authenticated"); mocks.actor.mockRejectedValue(failure);
  mocks.error.mockReturnValue(new Response(null, {status: 401}));
  expect((await POST(request(), params)).status).toBe(401);
  expect(mocks.exportAnswer).not.toHaveBeenCalled();
});
