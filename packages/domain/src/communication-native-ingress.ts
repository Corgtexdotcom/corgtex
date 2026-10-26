import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { beginAuthorizationContext } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { getSlackWorkspaceBinding } from "./slack-workspace-bindings";

export type SlackSignedIngress = Readonly<{
  workspaceId: string | null; rawBody: string; requestTimestamp: string; signature: string;
  bodyHash: string; signingBindingHash: string; receivedAtMs: number;
  payload: Readonly<Record<string, unknown>>;
}>;
const verified = new WeakSet<object>();
export function communicationNativeHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function communicationCanonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(communicationCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${communicationCanonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function freezeCommunicationPayload<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeCommunicationPayload); Object.freeze(value); }
  return value;
}
function slackSigningBindingHash(workspaceId?: string) {
  const binding = getSlackWorkspaceBinding(workspaceId);
  invariant(binding?.signingSecret, 503, "SLACK_NOT_CONFIGURED", "Slack request verification is unavailable.");
  return communicationNativeHash(communicationCanonicalJson({ workspaceId: workspaceId ?? null, source: binding.source,
    teamId: binding.teamId, appId: binding.appId, secretHash: communicationNativeHash(binding.signingSecret) }));
}
function parsedSlackPayload(rawBody: string): Record<string, unknown> {
  try {
    const form = new URLSearchParams(rawBody);
    const payload: unknown = rawBody.trimStart().startsWith("{") ? JSON.parse(rawBody)
      : form.has("payload") ? JSON.parse(form.get("payload")!) : Object.fromEntries(form);
    invariant(payload && typeof payload === "object" && !Array.isArray(payload), 400, "INVALID_SLACK_PAYLOAD", "Invalid Slack payload.");
    return payload as Record<string, unknown>;
  } catch { throw new AppError(400, "INVALID_SLACK_PAYLOAD", "Invalid Slack payload."); }
}
/** This opaque value can only be issued by checking the actual signed HTTP bytes. */
export function captureSlackSignedIngress(rawBody: string, headers: Headers | Record<string, string | string[] | undefined>, workspaceId?: string): SlackSignedIngress {
  const binding = getSlackWorkspaceBinding(workspaceId);
  invariant(binding?.signingSecret, 503, "SLACK_NOT_CONFIGURED", "Slack request verification is not configured for this workspace.");
  const read = (name: string) => { const value = headers instanceof Headers ? headers.get(name) : headers[name]; return Array.isArray(value) ? value[0] ?? "" : value ?? ""; };
  const requestTimestamp = read("x-slack-request-timestamp"), signature = read("x-slack-signature");
  invariant(/^\d+$/.test(requestTimestamp) && Math.abs(Date.now() / 1000 - Number(requestTimestamp)) <= 300,
    401, "INVALID_SLACK_SIGNATURE", "Slack request timestamp is outside the allowed window.");
  const expected = Buffer.from(`v0=${createHmac("sha256", binding.signingSecret).update(`v0:${requestTimestamp}:${rawBody}`).digest("hex")}`);
  const actual = Buffer.from(signature);
  invariant(actual.length === expected.length && timingSafeEqual(actual, expected), 401, "INVALID_SLACK_SIGNATURE", "Slack request signature is invalid.");
  const payload = parsedSlackPayload(rawBody);
  const team = payload.team && typeof payload.team === "object" ? (payload.team as Record<string, unknown>).id : undefined;
  if (binding.source === "workspace" && payload.type !== "url_verification") invariant((payload.team_id ?? team) === binding.teamId && payload.api_app_id === binding.appId,
    403, "SLACK_TENANT_MISMATCH", "Slack request does not match this workspace configuration.");
  const proof = freezeCommunicationPayload({ workspaceId: workspaceId ?? null, rawBody, requestTimestamp, signature,
    bodyHash: communicationNativeHash(rawBody), signingBindingHash: slackSigningBindingHash(workspaceId), receivedAtMs: Date.now(), payload });
  verified.add(proof);
  beginAuthorizationContext();
  return proof;
}
export function assertSlackSignedIngress(proof: SlackSignedIngress | undefined, payload: unknown, workspaceId?: string): asserts proof is SlackSignedIngress {
  invariant(proof && verified.has(proof) && (!proof.workspaceId || proof.workspaceId === workspaceId)
    && Math.abs(Date.now() / 1000 - Number(proof.requestTimestamp)) <= 300
    && proof.bodyHash === communicationNativeHash(proof.rawBody)
    && proof.signingBindingHash === slackSigningBindingHash(proof.workspaceId ?? undefined)
    && communicationCanonicalJson(proof.payload) === communicationCanonicalJson(payload),
  401, "INVALID_SLACK_SIGNATURE", "The actual authenticated Slack request is required.");
}
/** Persisted verification has no five-minute replay window; immutable signature, binding and epochs govern a queued event. */
export function isStoredSlackIngressSignatureCurrent(input: { workspaceId: string; requestTimestamp: string; signature: string; signingBindingHash: string }, rawBody: string): boolean {
  try {
    const workspaceId = input.signingBindingHash === slackSigningBindingHash(input.workspaceId) ? input.workspaceId : undefined;
    if (input.signingBindingHash !== slackSigningBindingHash(workspaceId)) return false;
    const binding = getSlackWorkspaceBinding(workspaceId);
    if (!binding?.signingSecret || !/^\d+$/.test(input.requestTimestamp)) return false;
    const actual = Buffer.from(input.signature), expected = Buffer.from(`v0=${createHmac("sha256", binding.signingSecret).update(`v0:${input.requestTimestamp}:${rawBody}`).digest("hex")}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
