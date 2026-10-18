import type {OAuthConnection} from "@prisma/client";
import {beforeEach, describe, expect, it, vi} from "vitest";

const {db} = vi.hoisted(() => ({db: {oAuthConnection: {findUnique: vi.fn(), update: vi.fn()}, $transaction: vi.fn()}}));
vi.mock("@corgtex/shared", () => ({prisma: db, encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, "")}));
vi.mock("./auth", () => ({requireWorkspaceMembership: vi.fn(async () => ({}))}));
import {refreshOAuthTokenIfNeeded, saveOAuthConnectionAndEnqueueCalendarSync} from "./integrations";

let current: OAuthConnection;
let beforeMutation: (() => Promise<void>) | undefined;
let revision: number;
beforeEach(() => {
  vi.resetAllMocks(); revision = 1; beforeMutation = undefined;
  current = {id: "connection", userId: "user", workspaceId: "workspace", provider: "GOOGLE", providerAccountId: "same-account",
    accessToken: "synthetic-old-access", refreshToken: "synthetic-old-refresh", tokenStorageVersion: "plaintext",
    expiresAt: new Date(0), scopes: [], providerEmail: null, status: "ACTIVE", syncSettings: {}, lastSyncAt: null,
    lastSyncError: null, disconnectedAt: null, createdAt: new Date(0), updatedAt: new Date(revision)};
  db.oAuthConnection.findUnique.mockImplementation(async () => ({...current}));
  db.$transaction.mockImplementation(async callback => callback(db));
  db.oAuthConnection.update.mockImplementation(async ({where, data}) => {
    const barrier = beforeMutation; beforeMutation = undefined; await barrier?.();
    if (!Object.entries(where).every(([key, expected]) => expected === undefined
      || (expected instanceof Date ? +expected === +current[key as keyof OAuthConnection]! : current[key as keyof OAuthConnection] === expected))) {
      throw Object.assign(new Error("Synthetic conditional write missed"), {code: "P2025"});
    }
    current = {...current, ...data, updatedAt: new Date(++revision)};
    return {...current};
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({access_token: "synthetic-refreshed-access",
    refresh_token: "synthetic-refreshed-refresh", expires_in: 3600})));
});
async function reconnect() {
  await saveOAuthConnectionAndEnqueueCalendarSync({kind: "user", user: {id: "user"}} as any,
    {workspaceId: "workspace", provider: current.provider, providerAccountId: "same-account",
      accessToken: "synthetic-reconnected-access", refreshToken: "synthetic-reconnected-refresh", expiresIn: 3600, enqueueCalendarSync: false});
}
function expectReconnected() {
  expect(current).toMatchObject({accessToken: "enc:synthetic-reconnected-access", refreshToken: "enc:synthetic-reconnected-refresh",
    status: "ACTIVE", lastSyncError: null, providerAccountId: "same-account"});
}
const controls = () => ({authorizeAttempt: vi.fn(async () => {}), expectedAccountId: "same-account"});

describe("OAuth credential generation fencing", () => {
  it.each([false, true])("preserves same-account reconnection at legacy migration with controls=%s", async guarded => {
    beforeMutation = reconnect;
    await expect(refreshOAuthTokenIfNeeded(current.id, guarded ? controls() : undefined)).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
    expectReconnected(); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not migrate credentials after the current attempt guard rejects", async () => {
    const guard = vi.fn(async () => {throw Object.assign(new Error("Synthetic expired attempt"), {code: "SOURCE_CHANGED"});});
    await expect(refreshOAuthTokenIfNeeded(current.id, {authorizeAttempt: guard})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(db.oAuthConnection.update).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  describe.each(["GOOGLE", "MICROSOFT"] as const)("%s", provider => {
    it.each([["success", false], ["success", true], ["denied", false], ["denied", true]] as const)("preserves reauthorization during refresh %s with controls=%s", async (outcome, guarded) => {
      current.provider = provider; current.tokenStorageVersion = "aes-256-gcm";
      current.accessToken = "enc:synthetic-old-access"; current.refreshToken = "enc:synthetic-old-refresh";
      vi.mocked(fetch).mockImplementation(async () => {
        await reconnect();
        return outcome === "success" ? Response.json({access_token: "synthetic-stale-result", expires_in: 3600})
          : Response.json({error: "invalid_grant"}, {status: 400});
      });
      await expect(refreshOAuthTokenIfNeeded(current.id, guarded ? controls() : undefined)).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
      expectReconnected();
    });
    it("uses its own migrated credential version for a successful refresh", async () => {
      current.provider = provider;
      const result = await refreshOAuthTokenIfNeeded(current.id, controls());
      expect(result).toMatchObject({accessToken: "enc:synthetic-refreshed-access", refreshToken: "enc:synthetic-refreshed-refresh", status: "ACTIVE"});
      expect(result).toEqual(current); expect(db.oAuthConnection.update).toHaveBeenCalledTimes(2);
      const [migration, refresh] = db.oAuthConnection.update.mock.calls.map(([query]) => query);
      expect(refresh.where.updatedAt).not.toEqual(migration.where.updatedAt);
    });
    it("still records definitive denial against its own migrated credentials", async () => {
      current.provider = provider;
      vi.mocked(fetch).mockResolvedValue(Response.json({error: "invalid_grant"}, {status: 400}));
      await expect(refreshOAuthTokenIfNeeded(current.id, controls())).rejects.toMatchObject({code: "OAUTH_PROVIDER_AUTH_REVOKED"});
      expect(current.status).toBe("ERROR"); expect(db.oAuthConnection.update).toHaveBeenCalledTimes(2);
    });
  });
});
