import { expect, it, vi } from "vitest";
import { assertDemoWorkspaceDisconnected, assertDemoPersonasQuiesced, DISABLED_DEMO_PERSONA_PASSWORD_HASH } from "./demo-credentials.mjs";

const models = ["workspaceSsoConfig", "meetingTranscriptSourceConnection", "communicationInstallation", "workspaceRecorderCalendarSource", "oAuthConnection", "externalMcpConnection", "aiWorkspaceConnection", "appInstallation", "externalDataSource", "webhookEndpoint", "selfServeSupportSession", "procurementSetupSession", "procurementTrial", "workspaceToolLink", "oAuthAuthorizationCode", "oAuthAccessToken", "mcpOAuthAuthorizationCode", "mcpOAuthAccessToken", "appSession", "agentCredential", "workspaceMeetingRecorderConfig", "meetingRecording", "workspaceBillingProfile", "aiUsageLedgerEntry", "event", "workflowJob"];
it.each(models)("refuses existing external authority before refreshing demo: %s", async (model) => {
  const db = Object.fromEntries(models.map((key) => [key, { count: vi.fn().mockResolvedValue(key === model ? 1 : 0) }]));
  await expect(assertDemoWorkspaceDisconnected(db, "confirmed-demo")).rejects.toThrow("external access");
  expect(db[model].count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "confirmed-demo" }) }));
});
it("allows a new or disconnected synthetic workspace", async () => {
  await assertDemoWorkspaceDisconnected({}, undefined);
  const db = Object.fromEntries(models.map((key) => [key, { count: vi.fn().mockResolvedValue(0) }]));
  await expect(assertDemoWorkspaceDisconnected(db, "confirmed-demo")).resolves.toBeUndefined();
});

const persona = { id: "persona", email: "fictional@jnj.demo.corgtex.app", passwordHash: DISABLED_DEMO_PERSONA_PASSWORD_HASH };
const quiescenceModels = ["session", "passwordResetToken", "oAuthAuthorizationCode", "mcpOAuthAuthorizationCode", "oAuthAccessToken", "mcpOAuthAccessToken", "appSession", "agentCredential", "member"];
it("rejects legacy login-capable personas without writes", async () => {
  await expect(assertDemoPersonasQuiesced({}, [{ ...persona, passwordHash: "scrypt$legacy$hash" }], "demo@jnj-demo.corgtex.app", "demo")).rejects.toThrow("quarantine");
});
it.each(quiescenceModels.filter((model) => model !== "member"))("rejects usable existing persona authority without writes: %s", async (model) => {
  const db = Object.fromEntries(quiescenceModels.map((key) => [key, { count: vi.fn().mockResolvedValue(key === model ? 1 : 0) }]));
  await expect(assertDemoPersonasQuiesced(db, [persona], "demo@jnj-demo.corgtex.app", "demo")).rejects.toThrow(/usable/);
});
it("refuses historical public administrator membership", async () => {
  const db = Object.fromEntries(quiescenceModels.map((key) => [key, { count: vi.fn().mockResolvedValue(0) }]));
  await expect(assertDemoPersonasQuiesced(db, [{ id: "public", email: "demo@jnj-demo.corgtex.app", passwordHash: "scrypt$public$hash" }], "demo@jnj-demo.corgtex.app", "demo")).rejects.toThrow("contributor");
});
it("allows disabled personas with no usable credentials", async () => {
  const db = Object.fromEntries(quiescenceModels.map((key) => [key, { count: vi.fn().mockResolvedValue(0) }]));
  await expect(assertDemoPersonasQuiesced(db, [persona], "demo@jnj-demo.corgtex.app", "demo")).resolves.toBeUndefined();
});
