type AdviceRequestAudience = {
  requestedByUserId: string;
  audienceType: string;
  targetCircleId: string | null;
  recipients: Array<{ memberId: string }>;
};

export function canActorReplyToAdviceRequest(request: AdviceRequestAudience, actor: {
  userId: string | null;
  memberId: string | null;
  circleIds: Iterable<string>;
}) {
  if (!actor.userId || !actor.memberId || request.requestedByUserId === actor.userId) {
    return false;
  }

  if (request.audienceType === "WORKSPACE") {
    return true;
  }

  if (request.audienceType === "MEMBERS") {
    return request.recipients.some((recipient) => recipient.memberId === actor.memberId);
  }

  if (request.audienceType === "CIRCLE") {
    return Boolean(request.targetCircleId && new Set(actor.circleIds).has(request.targetCircleId));
  }

  return false;
}
