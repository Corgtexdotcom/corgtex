import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAuthorizationContext, prisma, runWithSupportOrigin, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { isGlobalOperator, requireWorkspaceMembership, resolveSessionActor } from "./auth";
import { issueAuthorizationCode, exchangeAuthorizationCode, resolveOAuthAccessToken, refreshAccessToken } from "./oauth-server";
import { issueAgentCredential, resolveAgentActorFromBearer } from "./agent-auth";
import { changeWorkspaceSupportGrant, getSupportConnectorPreparationForConsent, getSupportSetup, requireUnmanagedMember, updateSupportSetup, withWorkspaceSupportExecution, supportCapabilityVersion } from "./workspace-support-access";
import { createSlackOAuthState, readSlackOAuthState } from "./communication";
import { saveOAuthConnectionAndEnqueueCalendarSync } from "./integrations";
import { createMember, updateMember } from "./members";
import { canManageWorkspaceSupport, lockWorkspaceMembership } from "./workspace-support-access";
import { linkOrProvisionSsoUser } from "./sso";

const workspaceIds: string[] = [];
const userIds: string[] = [];
let workspaceId: string;
let owner: Extract<AppActor, { kind: "user" }>;
let support: Extract<AppActor, { kind: "user" }>;
const supportTest = (name: string, run: () => Promise<void>) => it(name, () => runWithSupportOrigin(undefined, run));

async function change(role: "SETUP" | "FULL", expectedVersion = 0, isActive = true) {
  return runWithSupportOrigin(undefined, () => changeWorkspaceSupportGrant(owner, {
    workspaceId, email: support.user.email, role, expectedVersion, isActive,
  }));
}

describe("owner-selected support access", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    beginAuthorizationContext();
    const suffix = randomUUID();
    const ownerUser = await prisma.user.create({ data: { email: `owner-${suffix}@example.test`, passwordHash: "local-fixture" } });
    const supportUser = await prisma.user.create({ data: { email: `support-${suffix}@example.test`, passwordHash: "local-fixture", globalRole: "OPERATOR" } });
    userIds.push(ownerUser.id, supportUser.id);
    const workspace = await prisma.workspace.create({ data: { name: "Fixture workspace", slug: `support-${suffix}`, supportOwnerUserId: ownerUser.id } });
    workspaceId = workspace.id;
    workspaceIds.push(workspaceId);
    await prisma.member.create({ data: { workspaceId, userId: ownerUser.id, role: "ADMIN", kind: "HUMAN" } });
    owner = { kind: "user", user: ownerUser };
    support = { kind: "user", user: supportUser };
  });

  afterAll(async () => runWithSupportOrigin(undefined, async () => {
    await prisma.event.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.oAuthAccessToken.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }));

  supportTest("serializes ordinary membership creation behind the support workspace lock", async () => {
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      locked();
      await gate;
    });
    await acquired;
    let settled = false;
    const mutation = createMember(owner, { workspaceId, email: support.user.email, role: "CONTRIBUTOR" }).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
    } finally {
      release();
      await holder;
      await mutation;
    }
  });

  supportTest("defaults to a content-free grant and defeats a forged cached ADMIN membership", async () => {
    await change("SETUP");
    expect(await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } })).toBeNull();
    await expect(requireWorkspaceMembership({ actor: support, workspaceId, resolvedMembership: {
      id: "forged", workspaceId, userId: support.user.id, role: "ADMIN", isActive: true,
    } })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    await expect(requireWorkspaceMembership({ actor: support, workspaceId: randomUUID() })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(isGlobalOperator(support)).toBe(true);
    await expect(requireUnmanagedMember(prisma, workspaceId, support.user.id)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
  });

  supportTest("shows support management only to a verified active human owner", async () => {
    expect(await canManageWorkspaceSupport(owner, workspaceId)).toBe(true);
    expect(await canManageWorkspaceSupport(support, workspaceId)).toBe(false);
    await change("FULL");
    expect(await canManageWorkspaceSupport(support, workspaceId)).toBe(false);
    await prisma.workspace.update({ where: { id: workspaceId }, data: { supportOwnerUserId: null } });
    expect(await canManageWorkspaceSupport(owner, workspaceId)).toBe(false);
  });

  supportTest("does not turn SSO support login into ordinary membership", async () => {
    await change("SETUP");
    const input = { workspaceId, provider: "google", providerSubjectId: randomUUID(), email: support.user.email };
    await linkOrProvisionSsoUser(input);
    await linkOrProvisionSsoUser(input);
    expect(await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } })).toBeNull();
  });

  supportTest("serializes membership reactivation and grant creation in both lock orders", async () => {
    const member = await prisma.member.create({ data: { workspaceId, userId: support.user.id, role: "CONTRIBUTOR", isActive: false } });
    for (const supportFirst of [true, false]) {
      await prisma.workspaceSupportGrant.deleteMany({ where: { workspaceId } });
      await prisma.member.update({ where: { id: member.id }, data: { isActive: false } });
      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => { acquired = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = prisma.$transaction(async (tx) => {
        await lockWorkspaceMembership(tx, workspaceId);
        if (!supportFirst) await requireUnmanagedMember(tx, workspaceId, support.user.id);
        acquired();
        await gate;
        if (supportFirst) {
          await tx.workspaceSupportGrant.create({ data: { workspaceId, userId: support.user.id, grantedByUserId: owner.user.id, role: "SETUP" } });
        } else {
          await tx.member.update({ where: { id: member.id }, data: { isActive: true } });
        }
      });
      await held;
      const second = (supportFirst
        ? updateMember(owner, { workspaceId, memberId: member.id, isActive: true })
        : change("SETUP")).then(() => null, (error: { code: string }) => error.code);
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally { release(); }
      await first;
      expect(await second).toBe(supportFirst ? "SUPPORT_OWNER_REQUIRED" : "EXISTING_MEMBERSHIP");
      const actual = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      const grant = await prisma.workspaceSupportGrant.findUnique({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } });
      expect(actual.isActive && grant?.isActive).toBeFalsy();
    }
  });

  supportTest("requires the verified owner, never an arbitrary admin or support recipient", async () => {
    await change("SETUP");
    const input = { workspaceId, email: owner.user.email, role: "FULL" as const, isActive: true, expectedVersion: 0 };
    await expect(changeWorkspaceSupportGrant(support, input)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { supportOwnerUserId: null } });
    await expect(change("FULL", 1)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
  });

  supportTest("blocks Setup even for internal actors with an omitted support marker", async () => {
    await change("SETUP");
    await prisma.member.create({ data: { workspaceId, userId: support.user.id, role: "ADMIN", isActive: true } });
    await expect(requireWorkspaceMembership({ actor: { ...support, user: { ...support.user, isSupportAccount: undefined } }, workspaceId,
      resolvedMembership: { id: "stale", workspaceId, userId: support.user.id, role: "ADMIN", isActive: true },
    })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
  });

  supportTest("binds OAuth grants and agent descendants to a non-revivable Full grant version", async () => {
    await change("FULL");
    const app = await prisma.oAuthApp.create({ data: { workspaceId, clientId: randomUUID(), clientSecret: sha256("fixture-secret"), name: "Fixture OAuth", redirectUris: ["https://example.test/callback"], scopes: ["read"] } });
    const code = await issueAuthorizationCode(support, { workspaceId, clientId: app.clientId, redirectUri: app.redirectUris[0], scopes: ["read"] });
    const tokens = await exchangeAuthorizationCode({ code, clientId: app.clientId, clientSecret: "fixture-secret", redirectUri: app.redirectUris[0] });
    expect(await resolveOAuthAccessToken(tokens.access_token)).toMatchObject({ workspaceId });
    const issued = await issueAgentCredential(support, { workspaceId, label: "Support fixture", scopes: ["brain:read"] });
    expect(await resolveAgentActorFromBearer(issued.token)).toMatchObject({ supportOrigin: { userId: support.user.id, workspaceId, version: 1 } });
    expect(await prisma.agentCredential.findUnique({ where: { id: issued.credential.id } })).toMatchObject({ supportGrantVersion: 1 });
    await change("SETUP", 1);
    expect(await resolveOAuthAccessToken(tokens.access_token)).toBeNull();
    expect(await resolveAgentActorFromBearer(issued.token)).toBeNull();
    await change("FULL", 2);
    // Simulate a token write racing revocation. Version checking must still deny it.
    await prisma.oAuthAccessToken.updateMany({ where: { workspaceId }, data: { revokedAt: null } });
    await prisma.agentCredential.update({ where: { id: issued.credential.id }, data: { isActive: true } });
    await expect(resolveOAuthAccessToken(tokens.access_token)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    await expect(refreshAccessToken({ refreshToken: tokens.refresh_token, clientId: app.clientId, clientSecret: "fixture-secret" })).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(await resolveAgentActorFromBearer(issued.token)).toBeNull();
  });

  supportTest("returns only allowlisted connection metadata and bounded setup settings", async () => {
    await change("SETUP");
    await prisma.communicationInstallation.create({ data: {
      workspaceId, provider: "SLACK", externalWorkspaceId: randomUUID(),
      externalTeamName: "SECRET_CHANNEL", botTokenEnc: "SECRET_TOKEN", lastError: "SECRET_PAYLOAD",
      settings: { content: "SECRET_DOCUMENT" },
    } });
    const setup = await getSupportSetup(support, workspaceId);
    expect(setup.connections).toEqual([{ provider: "SLACK", status: "ACTIVE" }]);
    expect(JSON.stringify(setup)).not.toContain("SECRET");
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, checklist: { configurationPrepared: true } })).resolves.toEqual({ version: 1, setupRevision: 0 });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 2, checklist: { webhookUrl: true } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 0, checklist: {} })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  supportTest("Full enables real membership, while downgrade revokes credentials and queued work permanently", async () => {
    await change("FULL");
    await expect(requireWorkspaceMembership({ actor: support, workspaceId, allowedRoles: ["ADMIN"] })).resolves.toMatchObject({ role: "ADMIN", isActive: true });
    const origin = { userId: support.user.id, workspaceId, version: 1 };
    const event = await runWithSupportOrigin(origin, () => prisma.event.create({ data: { workspaceId, type: "support.test", payload: {} } }));
    expect(event).toMatchObject({ supportOriginUserId: support.user.id, supportGrantVersion: 1 });
    const credential = await prisma.agentCredential.create({ data: { workspaceId, createdByUserId: support.user.id, label: "test", tokenHash: randomUUID(), scopes: ["brain:read"] } });
    await change("SETUP", 1);
    expect(await prisma.agentCredential.findUnique({ where: { id: credential.id } })).toMatchObject({ isActive: false });
    const execute = vi.fn(async () => "content");
    await expect(withWorkspaceSupportExecution(event, execute)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    await expect(requireWorkspaceMembership({ actor: support, workspaceId })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    await change("FULL", 2);
    await expect(withWorkspaceSupportExecution(event, execute)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(execute).not.toHaveBeenCalled();
    await expect(runWithSupportOrigin(origin, () => prisma.event.create({ data: { workspaceId, type: "support.test", payload: {} } }))).rejects.toThrow("SUPPORT_AUTHORIZATION_REVOKED");
  });

  supportTest("persists bounded connector configuration without touching live connections or jobs, and requires owner review", async () => {
    const grant = await change("SETUP");
    const connectors = [{ provider: "google" as const, intent: "documents" as const, calendarImport: false }];
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, expectedSetupRevision: 0, checklist: {}, connectors })).resolves.toEqual({ version: 1, setupRevision: 1 });
    expect(await getSupportSetup(support, workspaceId)).toMatchObject({ connectors, setupRevision: 1 });
    expect(await prisma.oAuthConnection.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.workflowJob.count({ where: { workspaceId } })).toBe(0);
    const consent = { workspaceId, grantId: grant.id, revision: 1, provider: "google" };
    await expect(getSupportConnectorPreparationForConsent(support, consent)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await expect(getSupportConnectorPreparationForConsent(owner, consent)).resolves.toEqual(connectors[0]);
    await expect(getSupportConnectorPreparationForConsent(owner, { ...consent, revision: 0 })).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, expectedSetupRevision: 0, checklist: {}, connectors })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, expectedSetupRevision: 1, checklist: {}, connectors: [{ ...connectors[0], webhookUrl: "https://exfil.example.test" } as any] })).rejects.toThrow();
    await change("SETUP", 1, false);
    await expect(getSupportConnectorPreparationForConsent(owner, consent)).rejects.toMatchObject({ code: "PREPARATION_CHANGED" });
  });

  supportTest("enforces dedicated deployment scope on setup reads, mutations and owner grants", async () => {
    await change("SETUP");
    vi.stubEnv("WORKSPACE_SLUG", "different-workspace");
    vi.stubEnv("APP_URL", "https://dedicated.example.test");
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    await expect(getSupportSetup(support, workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_MISMATCH" });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, checklist: {} })).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_MISMATCH" });
    await expect(change("FULL", 1)).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_MISMATCH" });
  });

  supportTest("propagates provenance through transaction and bulk child job creation", async () => {
    await change("FULL");
    const origin = { userId: support.user.id, workspaceId, version: 1 };
    await runWithSupportOrigin(origin, () => prisma.$transaction(async (tx) => {
      const event = await tx.event.create({ data: { workspaceId, type: "support.fixture", payload: {} } });
      await tx.workflowJob.createMany({ data: [{ workspaceId, eventId: event.id, type: "support.fixture", payload: {} }, { workspaceId, type: "support.fixture", payload: {} }] });
    }));
    const jobs = await prisma.workflowJob.findMany({ where: { workspaceId } });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.supportOriginUserId === support.user.id && job.supportGrantVersion === 1)).toBe(true);
  });

  supportTest("existing login sessions retain platform authority while revoked grants cannot use setup", async () => {
    const token = randomUUID();
    await prisma.session.create({ data: { userId: support.user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
    await change("SETUP");
    const actor = await resolveSessionActor(token);
    expect(actor).toMatchObject({ user: { isSupportAccount: false } });
    expect(isGlobalOperator(actor!)).toBe(true);
    await change("SETUP", 1, false);
    await expect(getSupportSetup(actor!, workspaceId)).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
    await expect(updateSupportSetup(actor!, { workspaceId, expectedVersion: 2, checklist: {} })).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });

  for (const globalRole of ["USER", "OPERATOR"] as const) supportTest(`tenant B cannot change ${globalRole} authority, membership or credentials in A`, async () => {
    await prisma.user.update({ where: { id: support.user.id }, data: { globalRole } });
    support.user.globalRole = globalRole;
    const a = await prisma.workspace.create({ data: { name: "Independent A", slug: `support-a-${randomUUID()}` } });
    workspaceIds.push(a.id);
    await prisma.member.create({ data: { workspaceId: a.id, userId: support.user.id, role: "ADMIN", kind: "HUMAN" } });
    const token = randomUUID();
    await prisma.session.create({ data: { userId: support.user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
    const issued = await issueAgentCredential(support, { workspaceId: a.id, label: "Independent A", scopes: ["brain:read"] });
    for (const [role, version, active] of [["SETUP", 0, true], ["FULL", 1, true], ["SETUP", 2, true], ["SETUP", 3, false]] as const) {
      await change(role, version, active);
      const fresh = await resolveSessionActor(token);
      expect(isGlobalOperator(fresh!)).toBe(globalRole === "OPERATOR");
      expect(fresh).toMatchObject({ user: { isSupportAccount: false, globalRole } });
      await expect(runWithSupportOrigin(undefined, () => requireWorkspaceMembership({ actor: fresh!, workspaceId: a.id, allowedRoles: ["ADMIN"] }))).resolves.toMatchObject({ role: "ADMIN", isActive: true });
      const agent = await runWithSupportOrigin(undefined, () => resolveAgentActorFromBearer(issued.token));
      expect(agent).toMatchObject({ workspaceIds: [a.id] });
      expect(agent?.kind === "agent" && agent.supportOrigin).toBeUndefined();
      const event = await runWithSupportOrigin(undefined, async () => {
        await requireWorkspaceMembership({ actor: fresh!, workspaceId: a.id });
        return prisma.event.create({ data: { workspaceId: a.id, type: "independent-a", payload: {} } });
      });
      expect(event.supportOriginUserId).toBeNull();
      await expect(withWorkspaceSupportExecution(event, async () => "ordinary A work")).resolves.toBe("ordinary A work");
      if (role === "SETUP") await expect(runWithSupportOrigin(undefined, () => requireWorkspaceMembership({ actor: fresh!, workspaceId }))).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    }
  });

  supportTest("personal OAuth cannot detach a connection from a Setup-restricted workspace", async () => {
    await change("SETUP");
    const connection = await prisma.oAuthConnection.create({ data: { workspaceId, userId: support.user.id, provider: "GOOGLE", providerAccountId: "fixture", accessToken: "fixture-existing", status: "ACTIVE" } });
    await expect(saveOAuthConnectionAndEnqueueCalendarSync(support, { workspaceId: null, provider: "GOOGLE", providerAccountId: "changed", accessToken: "changed" })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    expect(await prisma.oAuthConnection.findUnique({ where: { id: connection.id } })).toMatchObject({ workspaceId, accessToken: "fixture-existing" });
  });

  supportTest("signed Slack consent cannot survive downgrade/regrant or be widened to the new version", async () => {
    await change("FULL");
    const state = createSlackOAuthState(workspaceId, { flow: { kind: "workspace", initiatedByUserId: support.user.id, supportGrantVersion: 1, preparedSelectedChannels: true } });
    await change("SETUP", 1);
    await change("FULL", 2);
    const original = readSlackOAuthState(state.value)!;
    await expect(supportCapabilityVersion(original.flow.initiatedByUserId, original.workspaceId, original.flow.supportGrantVersion)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    const [payload, signature] = state.value.split(".");
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), supportGrantVersion: 3 })).toString("base64url");
    expect(readSlackOAuthState(`${changed}.${signature}`)).toBeNull();
  });

  supportTest("serializes conflicting owner decisions and records only safe audit metadata", async () => {
    const results = await Promise.allSettled([change("SETUP"), change("FULL")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    const audits = await prisma.auditLog.findMany({ where: { workspaceId, entityType: "WorkspaceSupportGrant" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ recipientUserId: support.user.id, version: 1 });
    expect(JSON.stringify(audits[0].meta)).not.toContain(support.user.email);
  });
});
