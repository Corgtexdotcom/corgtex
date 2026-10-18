import type {OAuthConnection} from "@prisma/client";
import {beforeEach, describe, expect, it, vi} from "vitest";

const {db, index, touchpoints} = vi.hoisted(() => ({db: {oAuthConnection: {findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn()}, $transaction: vi.fn()}, index: vi.fn(), touchpoints: vi.fn()}));
vi.mock("@corgtex/shared", () => ({prisma: db, encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, "")}));
vi.mock("../../../domain/src/auth", () => ({requireWorkspaceMembership: vi.fn(async () => ({}))}));
vi.mock("../../../domain/src/oauth-provider-native", () => ({beginOAuthKnowledgeSync: vi.fn()}));
vi.mock("@corgtex/knowledge", () => ({syncKnowledgeForSource: index, syncDocumentKnowledge: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({
  fetchCalendarEvents: (await import("../../../domain/src/integrations")).fetchCalendarEvents,
  syncCalendarEventRecorder: vi.fn(), materializeCrmCalendarTouchpoints: touchpoints,
  externalResourceKnowledgeInput: vi.fn(), materializeCrmEmailTouchpoints: vi.fn(), syncExternalContentSource: vi.fn(),
}));
import {saveOAuthConnectionAndEnqueueCalendarSync} from "../../../domain/src/integrations";
import {handleCalendarSync} from "./knowledge-sync";

let current: OAuthConnection;
let beforeMutation: (() => Promise<void>) | undefined;
let revision: number;
function matches(where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => expected === undefined
    || (expected instanceof Date ? +expected === +current[key as keyof OAuthConnection]! : current[key as keyof OAuthConnection] === expected));
}
beforeEach(() => {
  vi.resetAllMocks(); revision = 1; beforeMutation = undefined;
  current = {id: "connection", userId: "user", workspaceId: "workspace", provider: "GOOGLE", providerAccountId: "same-account",
    accessToken: "synthetic-old-access", refreshToken: "synthetic-old-refresh", tokenStorageVersion: "plaintext",
    expiresAt: new Date(0), scopes: [], providerEmail: null, status: "ACTIVE", syncSettings: {calendar: {enabled: true}}, lastSyncAt: new Date(0),
    lastSyncError: null, disconnectedAt: null, createdAt: new Date(0), updatedAt: new Date(revision)};
  db.oAuthConnection.findUnique.mockImplementation(async () => ({...current}));
  db.oAuthConnection.findFirst.mockImplementation(async ({where}) => matches(where) ? {id: current.id} : null);
  db.$transaction.mockImplementation(async callback => callback(db));
  db.oAuthConnection.update.mockImplementation(async ({where, data}) => {
    const barrier = beforeMutation; beforeMutation = undefined; await barrier?.();
    if (!matches(where)) throw Object.assign(new Error("Synthetic conditional write missed"), {code: "P2025"});
    current = {...current, ...data, updatedAt: new Date(++revision)}; return {...current};
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes("token")
    ? Response.json({access_token: "synthetic-refreshed-access", refresh_token: "synthetic-refreshed-refresh", expires_in: 3600}) : events()));
});
function events() {
  const event = {id: "event", summary: "Synthetic meeting", subject: "Synthetic meeting", start: {dateTime: "2026-01-01T12:00:00Z"},
    end: {dateTime: "2026-01-01T13:00:00Z"}, attendees: [], hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", onlineMeeting: {joinUrl: "https://teams.microsoft.com/l/meetup-join/synthetic"}};
  return Response.json({items: [event], value: [event]});
}
async function reconnect() {
  await saveOAuthConnectionAndEnqueueCalendarSync({kind: "user", user: {id: "user"}} as any,
    {workspaceId: "workspace", provider: current.provider, providerAccountId: "same-account",
      accessToken: "synthetic-reconnected-access", refreshToken: "synthetic-reconnected-refresh", expiresIn: 3600,
      syncSettings: {calendar: {enabled: false}}, enqueueCalendarSync: false});
}
function expectReconnected() {
  expect(current).toMatchObject({accessToken: "enc:synthetic-reconnected-access", refreshToken: "enc:synthetic-reconnected-refresh",
    status: "ACTIVE", lastSyncError: null, lastSyncAt: new Date(0), syncSettings: {calendar: {enabled: false}}});
}
const run = () => handleCalendarSync("job", {connectionId: "connection"}, "workspace");
describe("calendar credential attempt fencing", () => {
  it.each(["GOOGLE", "MICROSOFT"] as const)("keeps normal %s migration, refresh, indexing and checkpoint working", async provider => {
    current.provider = provider;
    await run();
    expect(current).toMatchObject({status: "ACTIVE", accessToken: "enc:synthetic-refreshed-access", lastSyncError: null});
    expect(current.lastSyncAt!.getTime()).toBeGreaterThan(0);
    expect(index).toHaveBeenCalledTimes(1); expect(touchpoints).toHaveBeenCalledTimes(1);
    expect(db.oAuthConnection.update).toHaveBeenCalledTimes(3);
  });
  it("does not let migration failure's calendar catch overwrite the reconnect", async () => {
    beforeMutation = reconnect;
    await expect(run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
    expectReconnected(); expect(fetch).not.toHaveBeenCalled(); expect(index).not.toHaveBeenCalled();
  });
  it.each(["success", "denied"] as const)("stops after reconnect during token refresh %s without provider data or indexing", async outcome => {
    vi.mocked(fetch).mockImplementation(async () => {
      await reconnect(); return outcome === "success" ? Response.json({access_token: "synthetic-stale", expires_in: 3600})
        : Response.json({error: "invalid_grant"}, {status: 400});
    });
    await expect(run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
    expectReconnected(); expect(fetch).toHaveBeenCalledTimes(1); expect(index).not.toHaveBeenCalled(); expect(touchpoints).not.toHaveBeenCalled();
  });
  it("checks the original credential generation after fetching events and before indexing", async () => {
    current.tokenStorageVersion = "aes-256-gcm"; current.expiresAt = new Date(Date.now() + 3600_000);
    vi.mocked(fetch).mockImplementation(async () => {await reconnect(); return events();});
    await expect(run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
    expectReconnected(); expect(index).not.toHaveBeenCalled(); expect(touchpoints).not.toHaveBeenCalled();
  });
  it.each([false, true])("fences the final calendar status write with an atomic predicate (failure=%s)", async fails => {
    touchpoints.mockImplementation(async () => {
      beforeMutation = reconnect;
      if (fails) throw new Error("Synthetic provider failure");
    });
    await expect(run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
    expectReconnected();
  });
  it("still records ordinary failure against the attempt's own refreshed state", async () => {
    touchpoints.mockRejectedValue(new Error("Synthetic calendar failure"));
    await expect(run()).rejects.toThrow("Synthetic calendar failure");
    expect(current).toMatchObject({status: "ERROR", lastSyncError: "Synthetic calendar failure", lastSyncAt: new Date(0), accessToken: "enc:synthetic-refreshed-access"});
  });
});
