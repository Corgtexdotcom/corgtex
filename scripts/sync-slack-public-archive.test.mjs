import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./sync-slack-public-archive.mjs", import.meta.url), "utf8")
  .replace(/^#!.*\n/, "")
  .replace(/^import .*;\n/gm, "")
  .replace(/\nmain\(\)\n/, "\nreturn main()\n");
const run = new (Object.getPrototypeOf(async function () {}).constructor)("PrismaClient", "WebClient", "createDecipheriv", "process", "console", source);

async function execute(settings, extraEnv = {}) {
  const calls = { reads: 0, clients: 0, writes: 0, joins: 0, history: 0, disconnected: false };
  const key = Buffer.alloc(32, 1), iv = Buffer.alloc(12, 2);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update("synthetic-token"), cipher.final()]);
  const botTokenEnc = ["aes-256-gcm", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
  let savedSettings;
  const prisma = {
    workspace: { findUnique: async () => { calls.reads++; return { id: "ws-1" }; } },
    communicationInstallation: {
      findFirst: async () => ({ id: "i-1", workspaceId: "ws-1", settings, botTokenEnc, scopes: ["channels:history", "channels:join"] }),
      update: async ({ data }) => { calls.writes++; savedSettings = data.settings; },
    },
    communicationChannel: { upsert: async () => { calls.writes++; } },
    communicationMessage: { upsert: async () => { calls.writes++; } },
    $disconnect: async () => { calls.disconnected = true; },
  };
  class Client {
    constructor() { calls.clients++; }
    conversations = {
      list: async () => ({ channels: [{ id: "C1", name: "public", is_member: false }] }),
      join: async () => { calls.joins++; return { ok: true }; },
      history: async () => { calls.history++; return { messages: [] }; },
    };
  }
  const runtime = { env: { WORKSPACE_ID: "ws-1", ENCRYPTION_KEY: key.toString("hex"), ...extraEnv }, exitCode: 0 };
  const errors = [];
  await run(class { constructor() { return prisma; } }, Client, createDecipheriv, runtime, { log() {}, error: (value) => errors.push(value) });
  return { calls, errors, exitCode: runtime.exitCode, savedSettings };
}

for (const settings of [{ publicArchiveSyncEnabled: false }, { publicIngestionEnabled: false }, { broadPublicIngestion: false }, { channelAdmissionMode: "selected" }]) {
  test(`archive hold blocks all provider calls and writes: ${JSON.stringify(settings)}`, async () => {
    const result = await execute(settings, { ENCRYPTION_KEY: undefined });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0], /ingestion is held/);
    assert.deepEqual(result.calls, { reads: 1, clients: 0, writes: 0, joins: 0, history: 0, disconnected: true });
  });
}

for (const value of ["", "invalid", "{}"] ) {
  test(`defined scoped configuration blocks the broad CLI before lookup: ${JSON.stringify(value)}`, async () => {
    const result = await execute({}, { SLACK_WORKSPACE_BINDINGS_JSON: value, ENCRYPTION_KEY: undefined });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0], /workspace-scoped credentials/);
    assert.deepEqual(result.calls, { reads: 0, clients: 0, writes: 0, joins: 0, history: 0, disconnected: true });
  });
}

test("legacy archive respects an explicit auto-join hold", async () => {
  const result = await execute({ autoJoinPublicChannels: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.clients, 1);
  assert.equal(result.calls.joins, 0);
  assert.equal(result.calls.history, 0);
  assert.equal(result.savedSettings.autoJoinPublicChannels, false);
});

test("unrestricted legacy archive remains operational", async () => {
  const result = await execute({});
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.joins, 1);
  assert.equal(result.calls.history, 1);
  assert.equal(result.savedSettings.broadPublicIngestion, true);
});
