import { describe, expect, it } from "vitest";
import { canActorReplyToAdviceRequest } from "./advice-request-audience";

describe("canActorReplyToAdviceRequest", () => {
  const actor = {
    userId: "user-1",
    memberId: "member-1",
    circleIds: ["circle-1"],
  };

  it("allows selected recipients to reply", () => {
    expect(canActorReplyToAdviceRequest({
      requestedByUserId: "requester",
      audienceType: "MEMBERS",
      targetCircleId: null,
      recipients: [{ memberId: "member-1" }],
    }, actor)).toBe(true);
  });

  it("does not allow requesters to satisfy their own visible request", () => {
    expect(canActorReplyToAdviceRequest({
      requestedByUserId: "user-1",
      audienceType: "WORKSPACE",
      targetCircleId: null,
      recipients: [],
    }, actor)).toBe(false);
  });

  it("allows circle members and rejects unrelated members", () => {
    expect(canActorReplyToAdviceRequest({
      requestedByUserId: "requester",
      audienceType: "CIRCLE",
      targetCircleId: "circle-1",
      recipients: [],
    }, actor)).toBe(true);

    expect(canActorReplyToAdviceRequest({
      requestedByUserId: "requester",
      audienceType: "CIRCLE",
      targetCircleId: "circle-2",
      recipients: [],
    }, actor)).toBe(false);
  });
});
