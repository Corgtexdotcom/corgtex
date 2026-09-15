import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { db } = vi.hoisted(() => ({ db: {
  $transaction: vi.fn(),
  workspaceSupportGrant: { findUnique: vi.fn() },
  member: { findUnique: vi.fn(), findFirst: vi.fn() },
  catalogItem: { findFirst: vi.fn() },
  catalogRequest: { findFirst: vi.fn(), update: vi.fn() },
  agentCredential: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  appInstallation: { findFirst: vi.fn() },
  appSession: { create: vi.fn() },
  auditLog: { create: vi.fn() },
} }));
vi.mock("@corgtex/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/shared")>(), prisma: db,
}));

import { getSupportAuthorizationContext, runWithSupportOrigin } from "@corgtex/shared";
import { issueAgentCredential, rotateAgentCredential } from "./agent-auth";
import { issueEnterpriseAppSession, invokeInstalledAppTool } from "./enterprise-apps";
import { decideCatalogRequest } from "./catalog";
import { supportCapabilityVersion } from "./workspace-support-access";

const human: AppActor = { kind: "user", user: { id: "support", email: "support@example.test", displayName: null } };
const agent: AppActor = { kind: "agent", label: "delegated", authProvider: "credential", workspaceIds: ["ws"], scopes: ["support:write"],
  supportOrigin: { userId: "support", workspaceId: "ws", version: 1 } };
const installation = {
  id: "installation", workspaceId: "ws", status: "INSTALLED", grantedScopes: ["brain:read"],
  appDefinition: { appKey: "fixture-app", status: "ACTIVE", dataClassification: "INTERNAL" },
  runtime: { status: "ACTIVE", baseUrl: "https://fixture.example.test", mcpUrl: "https://fixture.example.test/mcp" },
};
const actions = [
  { name: "issue credential", lookup: db.catalogItem.findFirst, write: db.agentCredential.create,
    run: (actor: AppActor) => issueAgentCredential(actor, { workspaceId: "ws", label: "fixture", catalogItemId: "catalog", scopes: ["brain:read"] }) },
  { name: "rotate credential", lookup: db.agentCredential.findUnique, write: db.agentCredential.update,
    run: (actor: AppActor) => rotateAgentCredential(actor, { workspaceId: "ws", credentialId: "credential" }) },
  { name: "launch enterprise session", lookup: db.appInstallation.findFirst, write: db.appSession.create, humanOnly: true,
    run: (actor: AppActor) => issueEnterpriseAppSession(actor, { workspaceId: "ws", appInstallationId: "installation" }) },
  { name: "issue enterprise tool session", lookup: db.appInstallation.findFirst, write: db.appSession.create,
    run: (actor: AppActor) => invokeInstalledAppTool(actor, { workspaceId: "ws", appKey: "fixture-app", toolName: "fixture_read", requiredScopes: ["brain:read"] }) },
  { name: "approve catalog API key", lookup: db.catalogRequest.findFirst, write: db.agentCredential.create,
    run: (actor: AppActor) => decideCatalogRequest(actor, { workspaceId: "ws", requestId: "request", status: "APPROVED" }) },
];
let grant: { isActive: boolean; role: string; version: number } | null;
beforeEach(() => {
  vi.resetAllMocks();
  grant = { isActive: true, role: "FULL", version: 1 };
  db.workspaceSupportGrant.findUnique.mockImplementation(async ({ where }) => where.workspaceId_userId.workspaceId === "ws" && where.workspaceId_userId.userId === "support" ? grant : null);
  db.$transaction.mockImplementation(run => run(db));
  db.member.findUnique.mockResolvedValue({ id: "member", workspaceId: "ws", userId: "support", role: "ADMIN", isActive: true });
  db.member.findFirst.mockResolvedValue({ userId: "system" });
  db.catalogItem.findFirst.mockResolvedValue({ id: "catalog" });
  db.catalogRequest.findFirst.mockResolvedValue({ id: "request", type: "API_KEY", status: "PENDING", requesterUserId: "requester", catalogItem: { id: "catalog", title: "Fixture", requestedScopes: ["brain:read"] }, requestedScopes: ["brain:read"] });
  db.agentCredential.findUnique.mockResolvedValue({ id: "credential", workspaceId: "ws", label: "fixture", scopes: ["brain:read"] });
  db.agentCredential.create.mockResolvedValue({ id: "credential" });
  db.agentCredential.update.mockResolvedValue({ id: "credential" });
  db.appInstallation.findFirst.mockResolvedValue(installation);
  db.appSession.create.mockResolvedValue({ id: "session" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: "synthetic" })));
});
afterEach(() => vi.unstubAllGlobals());

describe("capability issuance uses actual membership authorization and captured request version", () => {
  for (const actor of [human, agent]) for (const action of actions.filter(action => !action.humanOnly || actor.kind === "user")) {
    it.each(["revoked", "regranted"])(`${actor.kind} ${action.name} rejects %s after the authorized lookup`, async state => {
      const original = action.lookup.getMockImplementation()!;
      action.lookup.mockImplementationOnce(async (...args) => {
        expect(getSupportAuthorizationContext()?.origin).toEqual({ userId: "support", workspaceId: "ws", version: 1 });
        grant = state === "regranted" ? { isActive: true, role: "FULL", version: 3 } : { isActive: false, role: "FULL", version: 2 };
        return original(...args);
      });
      await expect(runWithSupportOrigin<unknown>(undefined, () => action.run(actor))).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
      expect(action.write).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(db.catalogRequest.update).not.toHaveBeenCalled();
    });
    it(`${actor.kind} ${action.name} retains the current support origin`, async () => {
      await runWithSupportOrigin<unknown>(undefined, () => action.run(actor));
      expect(action.write).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        supportGrantVersion: 1,
        ...(action.write === db.appSession.create ? { actorUserId: "support" } : { createdByUserId: "support" }),
      }) }));
    });
    it(`${actor.kind} ${action.name} keeps ordinary workspace authority independent of support elsewhere`, async () => {
      grant = null;
      const ordinary = actor.kind === "agent" ? { ...actor, supportOrigin: undefined } : actor;
      // A grant elsewhere still exists; membership authorization queries only ws.
      db.workspaceSupportGrant.findUnique.mockImplementation(async ({ where }) => where.workspaceId_userId.workspaceId === "elsewhere" ? { isActive: true, role: "SETUP", version: 3 } : null);
      await runWithSupportOrigin<unknown>(undefined, () => action.run(ordinary));
      expect(action.write).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ supportGrantVersion: null }) }));
      if (action.name === "approve catalog API key") {
        expect(action.write).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ createdByUserId: "requester" }) }));
      }
    });
  }
  it("does not discover a fresh support capability when authorization captured none", async () => {
    await expect(runWithSupportOrigin(undefined, () => supportCapabilityVersion("support", "ws"))).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });
  it("does not reuse another workspace or user's captured support authorization", async () => {
    for (const origin of [{ userId: "support", workspaceId: "other", version: 1 }, { userId: "other", workspaceId: "ws", version: 1 }]) {
      await expect(runWithSupportOrigin(origin, () => supportCapabilityVersion("support", "ws"))).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    }
  });
});
