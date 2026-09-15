import { expect, it, vi } from "vitest";
import { assertDemoWorkspaceDisconnected } from "./demo-credentials.mjs";

const models = ["workspaceSsoConfig", "meetingTranscriptSourceConnection", "communicationInstallation", "workspaceRecorderCalendarSource", "oAuthConnection", "externalMcpConnection", "aiWorkspaceConnection", "appInstallation", "externalDataSource", "webhookEndpoint", "selfServeSupportSession", "procurementSetupSession", "procurementTrial", "workspaceToolLink", "oAuthAuthorizationCode", "oAuthAccessToken", "mcpOAuthAuthorizationCode", "mcpOAuthAccessToken", "appSession", "agentCredential", "workspaceMeetingRecorderConfig"];
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
