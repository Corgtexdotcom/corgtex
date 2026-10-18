import { expect, it, vi } from "vitest";
import { assertDemoCredentialsScoped, assertDemoWorkspaceDisconnected, assertDemoPersonasQuiesced, DISABLED_DEMO_PERSONA_PASSWORD_HASH, revokeDemoCredentials } from "./demo-credentials.mjs";

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

it.each([
  { workspaceId: "demo", isActive: false, role: "FULL" },
  { workspaceId: "demo", isActive: true, role: "SETUP" },
  { workspaceId: "demo", isActive: true, role: "FULL" },
  { workspaceId: "other", isActive: true, role: "FULL" },
])("refuses support grants that can divert demo visitors: %j", async (grant) => {
  const db = Object.fromEntries(models.map((key) => [key, { count: vi.fn().mockResolvedValue(0) }]));
  db.workspaceSupportGrant = { count: vi.fn(({ where }) => Promise.resolve(
    where.userId.in.includes("public") && (where.workspaceId?.not === undefined || grant.workspaceId !== where.workspaceId.not)
      && (where.isActive === undefined || grant.isActive === where.isActive) ? 1 : 0,
  )) };
  await expect(assertDemoCredentialsScoped(db, "demo", ["public"])).rejects.toThrow("support grants");
  expect(db.workspaceSupportGrant.count).toHaveBeenCalledWith({ where: { userId: { in: ["public"] } } });
});

it("uses the same credential operations/scopes inside an existing transaction without nesting", async () => {
  const operationModels = ["session", "passwordResetToken", "oAuthAuthorizationCode", "mcpOAuthAuthorizationCode",
    "oAuthAccessToken", "mcpOAuthAccessToken", "appSession", "agentCredential", "oAuthApp"];
  const db = Object.fromEntries(operationModels.map(model => [model, {
    deleteMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })),
  }]));
  db.$transaction = vi.fn(async operations => Promise.all(operations));
  await revokeDemoCredentials(db, "demo", ["public"]);
  const first = operationModels.map(model => ({ deletes: db[model].deleteMany.mock.calls, updates: db[model].updateMany.mock.calls }));
  for (const model of operationModels) { db[model].deleteMany.mockClear(); db[model].updateMany.mockClear(); }
  db.$transaction.mockClear();
  await revokeDemoCredentials(db, "demo", ["public"], { inTransaction: true });
  const withoutDates = calls => JSON.parse(JSON.stringify(calls, (key, value) => key === "revokedAt" ? "CURRENT_TIME" : value));
  expect(withoutDates(operationModels.map(model => ({ deletes: db[model].deleteMany.mock.calls, updates: db[model].updateMany.mock.calls }))))
    .toEqual(withoutDates(first));
  expect(db.$transaction).not.toHaveBeenCalled();
});
