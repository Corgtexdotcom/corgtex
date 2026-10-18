import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {decryptSecret, prisma, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../shared/src/db-test-utils";
import {refreshOAuthTokenIfNeeded, saveOAuthConnectionAndEnqueueCalendarSync, updateOAuthConnectionForAttempt} from "./integrations";

beforeEach(truncateAllTables);
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture(provider: "GOOGLE" | "MICROSOFT" = "GOOGLE") {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic OAuth CAS", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const original = await prisma.oAuthConnection.create({data: {workspaceId: workspace.id, userId: user.id, provider,
    providerAccountId: "same-account", accessToken: "synthetic-old-access", refreshToken: "synthetic-old-refresh", expiresAt: new Date(0),
    lastSyncAt: new Date(0), syncSettings: {calendar: {enabled: true}}}});
  const reconnect = () => saveOAuthConnectionAndEnqueueCalendarSync(actor, {workspaceId: workspace.id, provider, providerAccountId: "same-account",
    accessToken: "synthetic-reconnected-access", refreshToken: "synthetic-reconnected-refresh", expiresIn: 3600,
    syncSettings: {calendar: {enabled: false}}, enqueueCalendarSync: false});
  const expectReconnected = async () => {
    const stored = await prisma.oAuthConnection.findUniqueOrThrow({where: {id: original.id}});
    expect(decryptSecret(stored.accessToken)).toBe("synthetic-reconnected-access");
    expect(decryptSecret(stored.refreshToken!)).toBe("synthetic-reconnected-refresh");
    expect(stored).toMatchObject({status: "ACTIVE", lastSyncError: null, lastSyncAt: new Date(0), syncSettings: {calendar: {enabled: false}}});
  };
  return {original, reconnect, expectReconnected};
}

it("atomically refuses a plaintext migration after the actual same-account callback wins", async () => {
  const f = await fixture(), write = prisma.oAuthConnection.update.bind(prisma.oAuthConnection);
  let raced = false;
  vi.spyOn(prisma.oAuthConnection, "update").mockImplementation((async (args: any) => {
    if (!raced) {raced = true; await f.reconnect();}
    return write(args);
  }) as unknown as typeof prisma.oAuthConnection.update);
  vi.stubGlobal("fetch", vi.fn());
  await expect(refreshOAuthTokenIfNeeded(f.original.id)).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
  expect(raced).toBe(true); expect(fetch).not.toHaveBeenCalled(); await f.expectReconnected();
});

it.each([["GOOGLE", true], ["GOOGLE", false], ["MICROSOFT", true], ["MICROSOFT", false]] as const)
("preserves the committed %s callback against stale refresh success=%s", async (provider, success) => {
  const f = await fixture(provider);
  vi.stubGlobal("fetch", vi.fn(async () => {
    await f.reconnect();
    return success ? Response.json({access_token: "synthetic-stale-refresh", expires_in: 3600})
      : Response.json({error: "invalid_grant"}, {status: 400});
  }));
  await expect(refreshOAuthTokenIfNeeded(f.original.id, {authorizeAttempt: async () => {}}))
    .rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
  await f.expectReconnected();
});

it.each(["ACTIVE", "ERROR"] as const)("atomically fences the calendar %s write after the actual callback", async status => {
  const f = await fixture();
  await f.reconnect();
  await expect(updateOAuthConnectionForAttempt(f.original, {status, lastSyncAt: new Date(), lastSyncError: "Synthetic stale status"}))
    .rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
  await f.expectReconnected();
});

it.each(["GOOGLE", "MICROSOFT"] as const)("uses the returned %s migration and refresh versions for a successful checkpoint", async provider => {
  const f = await fixture(provider);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({access_token: "synthetic-refreshed-access", refresh_token: "synthetic-refreshed-refresh", expires_in: 3600})));
  const refreshed = await refreshOAuthTokenIfNeeded(f.original.id);
  expect(decryptSecret(refreshed.accessToken)).toBe("synthetic-refreshed-access");
  const checkpoint = await updateOAuthConnectionForAttempt(refreshed, {lastSyncAt: new Date(), status: "ACTIVE"});
  expect(checkpoint.lastSyncAt!.getTime()).toBeGreaterThan(0);
  expect(checkpoint.accessToken).toBe(refreshed.accessToken);
});
