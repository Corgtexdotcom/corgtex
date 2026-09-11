import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {
  workspace: { findFirst: vi.fn() },
  meeting: { findMany: vi.fn(), create: vi.fn() },
  meetingRecording: { update: vi.fn() },
  meetingRecorderProviderEvent: { updateMany: vi.fn() },
  workspaceFeatureFlag: { findUnique: vi.fn(), upsert: vi.fn() },
  workspaceMeetingRecorderConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  workflowJob: { upsert: vi.fn() },
  $transaction: vi.fn(), $disconnect: vi.fn(),
} }));
vi.mock("@prisma/client", () => ({ default: {
  Prisma: { JsonNull: null },
  PrismaClient: function () { return prisma; },
} }));

import { cancelRecall, main as cleanup } from "./meeting-recorder-cleanup.mjs";
import { envStatus, main as enable } from "./meeting-recorder-enable.mjs";
import { requiredProviderEnv, main as smoke } from "./meeting-recorder-smoke.mjs";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const bindings = Object.fromEntries(ids.map((id, i) => [id, {
  apiKey: `synthetic-key-${i}`, webhookSecret: `synthetic-signing-${i}`,
  region: ["us-east-1", "eu-central-1", "us-west-2"][i], providerWorkspaceId: `provider-${i}`,
}]));
const setMap = (value = bindings) => vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", JSON.stringify(value));
const bot = (workspaceId = ids[0], id = "duplicate") => ({
  id, workspaceId, meetingId: "meeting", provider: "RECALL_AI", externalBotId: id,
  status: "SCHEDULED", joinAt: new Date("2026-10-01T12:00:00Z"),
  scheduledAt: new Date(id === "canonical" ? "2026-09-12" : "2026-09-11"),
  createdAt: new Date("2026-09-11"), activeDedupeKey: null, failureCode: null,
  meeting: { recordedAt: new Date("2026-10-01T12:00:00Z") },
});
const cleanupArgs = ["--workspace", "resolved-slug", "--from", "2026-10-01", "--to", "2026-10-02", "--apply"];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
  vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", undefined);
  vi.stubEnv("RECALL_API_KEY", "legacy-key");
  vi.stubEnv("RECALL_WEBHOOK_SECRET", "legacy-signing");
  vi.stubEnv("RECALL_REGION", "us-west-2");
  vi.stubEnv("APP_URL", "https://app.example.com");
  vi.stubEnv("MEETING_RECORDER_PUBLIC_BASE_URL", "https://app.example.com");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/never-connected");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.spyOn(console, "log").mockImplementation(() => {});
  prisma.workspace.findFirst.mockResolvedValue({ id: ids[0], slug: "resolved-slug", name: "Synthetic" });
  prisma.meeting.findMany.mockResolvedValue([{ id: "meeting", recordings: [bot(ids[0], "canonical"), bot()] }]);
  prisma.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
  prisma.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({ enabled: true, defaultProvider: "RECALL_AI", fallbackProvider: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("standalone recorder scripts share the domain Recall contract", () => {
  it.each([0, 1, 2])("uses map-only binding %i for cancellation, enable readiness and smoke", async (i) => {
    setMap(); vi.stubEnv("RECALL_API_KEY", undefined); vi.stubEnv("RECALL_WEBHOOK_SECRET", undefined);
    await expect(cancelRecall(bot(ids[i]))).resolves.toBe("delete");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://${bindings[ids[i]].region}.recall.ai/api/v1/bot/duplicate/`,
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ Authorization: `Token synthetic-key-${i}` }) }));
    const result = envStatus("RECALL_AI", null, ids[i]);
    expect(result.status).toMatchObject({ recallApiKey: true, recallWebhookSecret: true });
    expect(result.webhookUrls.recall).toBe(`https://app.example.com/api/integrations/meeting-recorders/recall/${ids[i]}/webhook`);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-key|synthetic-signing/);
    expect(requiredProviderEnv("RECALL_AI", ids[i])).toEqual([["RECALL_API_KEY", `synthetic-key-${i}`], ["RECALL_WEBHOOK_SECRET", `synthetic-signing-${i}`]]);
  });

  it("does not mark cancellation or restore a canonical row on scoped account 404", async () => {
    setMap(); fetch.mockResolvedValue(new Response("not found", { status: 404 }));
    await cleanup(cleanupArgs);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prisma.meetingRecording.update).not.toHaveBeenCalled();
    const summary = JSON.parse(console.log.mock.calls.at(-1)[0]);
    expect(summary).toMatchObject({ duplicateProviderBotsCancelled: 0, duplicateRecordersSkipped: 0, duplicateProviderBotCancellationFailures: 1 });
  });

  it("also refuses scoped leave-call 404 instead of treating the bot as cancelled", async () => {
    setMap(); fetch.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(cancelRecall({ ...bot(ids[1]), status: "RECORDING" })).rejects.toThrow("RECALL_AI returned 404.");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://eu-central-1.recall.ai/api/v1/bot/duplicate/leave_call/", expect.any(Object));
  });

  it("preserves legacy global credentials, callback and already-missing cancellation", async () => {
    fetch.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(cancelRecall(bot())).resolves.toBe("delete");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Token legacy-key");
    expect(envStatus("RECALL_AI", null, ids[0]).webhookUrls.recall).toBe("https://app.example.com/api/integrations/meeting-recorders/recall/webhook");
    expect(requiredProviderEnv("RECALL_AI", ids[0])).toEqual([["RECALL_API_KEY", "legacy-key"], ["RECALL_WEBHOOK_SECRET", "legacy-signing"]]);
  });

  it.each(["", "{}", "{broken", JSON.stringify({ [ids[0]]: { ...bindings[ids[0]], region: "bad.example/" } })])("rejects malformed map before cleanup or enable writes: %j", async (raw) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", raw);
    await expect(cleanup(cleanupArgs)).rejects.toMatchObject({ status: 503, code: "RECALL_WORKSPACE_BINDINGS_INVALID" });
    await expect(enable(["--workspace", "resolved-slug", "--fallback-provider", "none"])).rejects.toMatchObject({ status: 503, code: "RECALL_WORKSPACE_BINDINGS_INVALID" });
    expect(() => requiredProviderEnv("RECALL_AI", ids[0])).toThrow(expect.objectContaining({ status: 503 }));
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.meetingRecording.update).not.toHaveBeenCalled();
    expect(prisma.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
    expect(prisma.workspaceMeetingRecorderConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed map", "{broken"],
    ["empty map", "{}"],
    ["missing workspace binding", JSON.stringify({ [ids[1]]: bindings[ids[1]] })],
    ["missing legacy credentials", undefined],
  ])("allows local disable with %s without provider calls or reconcile jobs", async (_label, raw) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", raw);
    vi.stubEnv("RECALL_API_KEY", undefined);
    vi.stubEnv("RECALL_WEBHOOK_SECRET", undefined);
    prisma.workspaceFeatureFlag.upsert.mockImplementation(async ({ update }) => ({ flag: "MEETING_RECORDERS", ...update }));
    prisma.workspaceMeetingRecorderConfig.upsert.mockImplementation(async ({ update }) => update);
    prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations));

    await enable(["--workspace", "resolved-slug", "--disabled"]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_flag: { workspaceId: ids[0], flag: "MEETING_RECORDERS" } },
      update: { enabled: false },
      create: expect.objectContaining({ workspaceId: ids[0], enabled: false }),
    }));
    expect(prisma.workspaceMeetingRecorderConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: ids[0] },
      update: expect.objectContaining({ enabled: false }),
      create: expect.objectContaining({ workspaceId: ids[0], enabled: false }),
    }));
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.workflowJob.upsert).not.toHaveBeenCalled();
    expect(JSON.parse(console.log.mock.calls.at(-1)[0])).toMatchObject({
      featureFlag: { enabled: false }, config: { enabled: false },
      reconcileJob: null, env: null, webhookUrls: null, warnings: [],
    });
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([null, "MEETING_BAAS"])("enables BaaS-only with fallback %s despite malformed unrelated Recall configuration", async (fallback) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", "{broken");
    vi.stubEnv("MEETING_BAAS_API_KEY", "synthetic-baas-key");
    vi.stubEnv("MEETING_BAAS_WEBHOOK_SECRET", "synthetic-baas-secret");
    prisma.workspaceFeatureFlag.upsert.mockImplementation(async ({ update }) => ({ flag: "MEETING_RECORDERS", ...update }));
    prisma.workspaceMeetingRecorderConfig.upsert.mockImplementation(async ({ update }) => update);
    prisma.$transaction.mockImplementation(async (operations) => Promise.all(operations));
    await enable(["--workspace", "resolved-slug", "--default-provider", "baas", "--fallback-provider", fallback ? "baas" : "none"]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceMeetingRecorderConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ enabled: true, defaultProvider: "MEETING_BAAS", fallbackProvider: fallback }),
    }));
    expect(prisma.workflowJob.upsert).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["{broken", JSON.stringify({ [ids[1]]: bindings[ids[1]] })])("keeps Recall fallback enable fail-closed: %s", async (raw) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", raw);
    await expect(enable(["--workspace", "resolved-slug", "--default-provider", "baas", "--fallback-provider", "recall"])).rejects.toMatchObject({ status: 503 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["{broken", JSON.stringify({ [ids[1]]: bindings[ids[1]] })])("inventories mixed providers in default and explicit dry-run with invalid Recall binding: %s", async (raw) => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", raw);
    prisma.meeting.findMany.mockResolvedValue([{ id: "meeting", recordings: [
      { ...bot(ids[0], "baas-1"), provider: "MEETING_BAAS" },
      { ...bot(ids[0], "baas-2"), provider: "MEETING_BAAS" },
      bot(ids[0], "canonical"), bot(),
    ] }]);
    for (const extra of [[], ["--dry-run"]]) {
      await cleanup([...cleanupArgs.slice(0, -1), ...extra, "--enqueue-reconcile"]);
      expect(JSON.parse(console.log.mock.calls.at(-1)[0])).toMatchObject({ mode: "dry-run", duplicateGroupsFound: 2 });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.meetingRecording.update).not.toHaveBeenCalled();
    expect(prisma.workflowJob.upsert).not.toHaveBeenCalled();
    await expect(cleanup(cleanupArgs)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("applies BaaS-only cleanup despite malformed unrelated Recall configuration", async () => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", "{broken");
    vi.stubEnv("MEETING_BAAS_API_KEY", "synthetic-baas-key");
    prisma.meeting.findMany.mockResolvedValue([{ id: "meeting", recordings: [
      { ...bot(ids[0], "canonical"), provider: "MEETING_BAAS" },
      { ...bot(), provider: "MEETING_BAAS" },
    ] }]);
    await cleanup(cleanupArgs);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prisma.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "duplicate" }, data: expect.objectContaining({ status: "SKIPPED" }) }));
  });

  it("smoke validates only the selected providers, including default/fallback and explicit override", async () => {
    vi.stubEnv("RECALL_WORKSPACE_BINDINGS_JSON", "{broken");
    vi.stubEnv("MEETING_BAAS_API_KEY", "synthetic-baas-key");
    vi.stubEnv("MEETING_BAAS_WEBHOOK_SECRET", "synthetic-baas-secret");
    const args = ["https://app.example.com", "synthetic@example.com", "synthetic-password", "resolved-slug", "https://meet.google.com/abc-defg-hij", "2026-10-01T12:00:00Z"];
    await smoke([...args, "--provider", "baas"]);
    prisma.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({ enabled: true, defaultProvider: "MEETING_BAAS", fallbackProvider: null });
    await smoke(args);
    prisma.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({ enabled: true, defaultProvider: "MEETING_BAAS", fallbackProvider: "RECALL_AI" });
    await expect(smoke(args)).rejects.toMatchObject({ status: 503 });
    await expect(smoke([...args, "--provider", "recall"])).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.meeting.create).not.toHaveBeenCalled();
  });

  it("checks all persisted recording bindings before cancelling even an earlier valid row", async () => {
    setMap({ [ids[0]]: bindings[ids[0]] });
    prisma.meeting.findMany.mockResolvedValue([{ id: "meeting", recordings: [bot(ids[0]), bot(ids[1])] }]);
    await expect(cleanup(cleanupArgs)).rejects.toMatchObject({ code: "RECORDER_VENDOR_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled(); expect(prisma.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("rejects an absent resolved workspace before enable or live smoke mutations despite global keys", async () => {
    setMap({ [ids[1]]: bindings[ids[1]] });
    await expect(enable(["--workspace", "resolved-slug"])).rejects.toMatchObject({ status: 503 });
    await expect(smoke(["https://app.example.com", "synthetic@example.com", "synthetic-password", "resolved-slug", "https://meet.google.com/abc-defg-hij", "2026-10-01T12:00:00Z", "--confirm-live-vendor-call"]))
      .rejects.toMatchObject({ status: 503 });
    expect(prisma.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
    expect(prisma.meeting.create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
