import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {decryptSecret, prisma, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../shared/src/db-test-utils";
import {getCalendarAvailability, refreshOAuthTokenIfNeeded, saveOAuthConnectionAndEnqueueCalendarSync, updateOAuthConnectionForAttempt} from "./integrations";

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


it.each(["GOOGLE", "MICROSOFT"] as const)("checks %s availability with real credential CAS and a fresh recovery attempt", async provider => {
  const f = await fixture(provider);
  await prisma.oAuthConnection.update({where: {id: f.original.id}, data: {
    scopes: [provider === "GOOGLE" ? "https://www.googleapis.com/auth/calendar.readonly" : "Calendars.Read"],
  }});
  const user = await prisma.user.findUniqueOrThrow({where: {id: f.original.userId}});
  const actor: AppActor = {kind: "user", user};
  const params = {workspaceId: f.original.workspaceId!, provider, emails: [user.email],
    timeMin: "2026-10-14T09:00:00Z", timeMax: "2026-10-14T17:00:00Z"};
  const reply = () => Response.json(provider === "GOOGLE" ? {calendars: {[user.email]: {busy: []}}}
    : {value: [{scheduleId: user.email, scheduleItems: []}]});
  // Migrate legacy synthetic credentials before comparing the unchanged grant.
  await prisma.oAuthConnection.update({where: {id: f.original.id}, data: {expiresAt: new Date(Date.now() + 3600_000)}});
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  expect(await getCalendarAvailability(actor, params)).toMatchObject({provider});
  await prisma.oAuthConnection.update({where: {id: f.original.id}, data: {expiresAt: new Date(0)}});
  const before = await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.original.id}});
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(new Response("temporary", {status: 503}));
  expect(await getCalendarAvailability(actor, params)).toHaveProperty("error");
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: before.id}})).toEqual(before);
  vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json({access_token: "synthetic-recovery", expires_in: 3600}))
    .mockImplementationOnce(async () => reply());
  expect(await getCalendarAvailability(actor, params)).toMatchObject({provider});
  expect(fetch).toHaveBeenCalledTimes(2);
  // A real concurrent disconnect while the provider response is in flight is withheld.
  vi.mocked(fetch).mockReset().mockImplementationOnce(async () => {
    await prisma.oAuthConnection.update({where: {id: before.id}, data: {status: "DISCONNECTED"}});
    return reply();
  });
  expect(await getCalendarAvailability(actor, params)).toHaveProperty("error");
  expect((await prisma.oAuthConnection.findUniqueOrThrow({where: {id: before.id}})).status).toBe("DISCONNECTED");
});
