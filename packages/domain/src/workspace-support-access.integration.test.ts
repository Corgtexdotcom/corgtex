import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupportAuthorizationContext, prisma, runWithSupportOrigin } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { changeWorkspaceSupportGrant, getSupportSetup, updateSupportSetup, withWorkspaceSupportExecution } from "./workspace-support-access";
import { createMember, updateMember } from "./members";
import { listSources as listBrainSources } from "./brain";
import { handleSlackCommand } from "./communication";
import { changeSupportConfiguration, decideSupportAccessRequest, getSupportConfiguration, listSupportAccessRequests } from "./workspace-support-configuration";
import { requireSupportRequestAccess } from "../../../apps/web/lib/support-request-access";
import { deriveJobsForEvent } from "../../workflows/src/derive-jobs";
import { handleContextGraphSync } from "../../workflows/src/handlers/context-graph-sync";
import * as events from "./events";
import { issueAgentCredential, rotateAgentCredential } from "./agent-auth";
import { assertTrialMemberCapacity } from "./trial-entitlements";

const { setupEmail } = vi.hoisted(() => ({ setupEmail: vi.fn() }));
const capabilityLookup = vi.hoisted(() => ({ model: "", run: undefined as (() => Promise<void>) | undefined }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return { ...actual, prisma: actual.prisma.$extends({ query: { $allModels: {
    async $allOperations({ model, operation, args, query }) {
      const result = await query(args);
      if (capabilityLookup.run && model === capabilityLookup.model && ["findFirst", "findUnique"].includes(operation)) {
        const run = capabilityLookup.run;
        capabilityLookup.run = undefined;
        await run();
      }
      return result;
    },
  } } }) };
});
vi.mock("./members", async importOriginal => ({
  ...await importOriginal<typeof import("./members")>(),
  sendMemberSetupEmail: setupEmail,
}));

const workspaces: string[] = [], users: string[] = [];
let workspaceId: string;
let owner: Extract<AppActor, { kind: "user" }>, support: Extract<AppActor, { kind: "user" }>;
const isolated = (name: string, run: () => Promise<void>) => it(name, () => runWithSupportOrigin(undefined, run));
const change = (role: "SETUP" | "FULL", expectedVersion = 0, isActive = true) => runWithSupportOrigin(undefined,
  () => changeWorkspaceSupportGrant(owner, { workspaceId, email: support.user.email, role, expectedVersion, isActive }));

describe("workspace admin support contract on migrated PostgreSQL", () => {
  beforeEach(async () => runWithSupportOrigin(undefined, async () => {
    setupEmail.mockReset().mockResolvedValue({ sent: true });
    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `owner-${suffix}@example.test`, passwordHash: "synthetic" } });
    const b = await prisma.user.create({ data: { email: `support-${suffix}@example.test`, passwordHash: "synthetic", globalRole: "OPERATOR" } });
    users.push(a.id, b.id); owner = { kind: "user", user: a }; support = { kind: "user", user: b };
    const w = await prisma.workspace.create({ data: { slug: suffix, name: "Synthetic support workspace", supportOwnerUserId: a.id } });
    workspaceId = w.id; workspaces.push(w.id);
    await prisma.member.create({ data: { workspaceId, userId: a.id, role: "ADMIN", kind: "HUMAN" } });
    await prisma.brainSource.create({ data: { workspaceId, sourceType: "DOC", tier: 1, title: "Synthetic private canary", content: "synthetic-content-canary" } });
  }));
  afterAll(async () => runWithSupportOrigin(undefined, async () => {
    await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.event.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }));

  isolated("grant-managed member transitions emit events and synchronize current graph state", async () => {
    await change("SETUP");
    expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(0);
    const check = async (type: string, active: boolean, count: number) => {
      const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } });
      const records = await prisma.event.findMany({ where: { workspaceId, aggregateId: member.id }, orderBy: { createdAt: "asc" } });
      expect(records).toHaveLength(count);
      const event = records.at(-1)!;
      expect(event).toMatchObject({ type, supportOriginUserId: null, supportGrantVersion: null });
      const derived = deriveJobsForEvent(event).filter(job => job.type === "context-graph.sync");
      expect(derived).toHaveLength(1);
      const { dependsOnDedupeKey: _dependency, ...data } = derived[0];
      const job = await prisma.workflowJob.create({ data });
      await withWorkspaceSupportExecution(job, () => handleContextGraphSync(job.id, job.payload as { sourceType: string; sourceId: string }, workspaceId));
      expect(await prisma.contextGraphObject.findFirst({ where: { workspaceId, sourceEntityType: "Member", sourceEntityId: member.id } })).toMatchObject({
        status: active ? "approved" : "archived", properties: { workspaceRole: "ADMIN", isActive: active },
      });
    };
    await change("FULL", 1);
    await check("member.created", true, 1);
    await change("FULL", 2);
    expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(1);
    await change("SETUP", 3);
    await check("member.deactivated", false, 2);
    await change("SETUP", 4, false);
    expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(2);
    await change("FULL", 5);
    await check("member.reactivated", true, 3);
    await change("FULL", 6, false);
    await check("member.deactivated", false, 4);
  });
  isolated("grant member event failure rolls back the grant and member together", async () => {
    const emit = vi.spyOn(events, "appendEvents").mockRejectedValueOnce(new Error("synthetic grant event failure"));
    try {
      await expect(change("FULL")).rejects.toThrow("synthetic grant event failure");
    } finally { emit.mockRestore(); }
    const where = { workspaceId_userId: { workspaceId, userId: support.user.id } };
    expect(await prisma.workspaceSupportGrant.findUnique({ where })).toBeNull();
    expect(await prisma.member.findUnique({ where })).toBeNull();
    expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(0);
    await change("FULL");
    expect(await prisma.event.count({ where: { workspaceId, type: "member.created" } })).toBe(1);
  });
  isolated("Setup cannot use global role, cached ADMIN, real content loader or self-grant", async () => {
    await change("SETUP");
    expect(await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } })).toBeNull();
    await expect(requireWorkspaceMembership({ actor: support, workspaceId, resolvedMembership: {
      id: "forged", workspaceId, userId: support.user.id, role: "ADMIN", isActive: true,
    } })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    await expect(listBrainSources(support, { workspaceId })).rejects.toMatchObject({ status: 403 });
    await expect(changeWorkspaceSupportGrant(support, { workspaceId, email: support.user.email, role: "FULL", expectedVersion: 1, isActive: true })).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
  });
  isolated("Setup writes allowlisted configuration only and rejects destinations or stale versions", async () => {
    await change("SETUP");
    const connectors = [{ provider: "google" as const, intent: "documents" as const, calendarImport: false }];
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, expectedSetupRevision: 0, checklist: { configurationPrepared: true }, connectors })).resolves.toMatchObject({ setupRevision: 1 });
    const dto = await getSupportSetup(support, workspaceId);
    expect(dto).toMatchObject({ connectors, role: "SETUP", setupRevision: 1 });
    expect(Object.keys(dto).sort()).toEqual(["checklist", "connections", "connectors", "role", "setupRevision", "version", "workspace"]);
    expect(JSON.stringify(dto)).not.toContain(support.user.email);
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 1, checklist: { webhookUrl: true } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(updateSupportSetup(support, { workspaceId, expectedVersion: 0, checklist: {} })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await prisma.workflowJob.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.oAuthConnection.count({ where: { workspaceId } })).toBe(0);
  });
  isolated("Full reads real content and config; downgrade revokes first-party credentials and old queued work", async () => {
    await change("FULL");
    await expect(requireWorkspaceMembership({ actor: support, workspaceId, allowedRoles: ["ADMIN"] })).resolves.toMatchObject({ role: "ADMIN" });
    expect(JSON.stringify(await listBrainSources(support, { workspaceId }))).toContain("synthetic-content-canary");
    const credential = await prisma.agentCredential.create({ data: { workspaceId, createdByUserId: support.user.id, label: "Synthetic", tokenHash: randomUUID(), scopes: ["brain:read"] } });
    const origin = { userId: support.user.id, workspaceId, version: 1 };
    const event = await runWithSupportOrigin(origin, () => prisma.event.create({ data: { workspaceId, type: "synthetic.support", payload: {} } }));
    expect(event.supportGrantVersion).toBe(1);
    await change("SETUP", 1);
    expect(await prisma.agentCredential.findUnique({ where: { id: credential.id } })).toMatchObject({ isActive: false });
    const handler = vi.fn(async () => "content");
    await expect(withWorkspaceSupportExecution(event, handler)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    await change("FULL", 2);
    await expect(withWorkspaceSupportExecution(event, handler)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(handler).not.toHaveBeenCalled();
    await change("FULL", 3, false);
    await expect(getSupportSetup(support, workspaceId)).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
    await expect(listBrainSources(support, { workspaceId })).rejects.toMatchObject({ status: 403 });
  });
  isolated("Full cannot change its own membership or the verified owner's membership", async () => {
    await change("FULL");
    const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } });
    await expect(updateMember(support, { workspaceId, memberId: member.id, role: "ADMIN" })).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    const ownerMember = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: owner.user.id } } });
    await expect(updateMember(support, { workspaceId, memberId: ownerMember.id, isActive: false })).rejects.toMatchObject({ code: "SUPPORT_OWNER_PROTECTED" });
  });
  isolated("owner opt-out cannot be overridden by ordinary membership APIs", async () => {
    await change("FULL"); await change("FULL", 1, false);
    await expect(createMember(owner, { workspaceId, email: support.user.email, role: "ADMIN" })).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await expect(requireWorkspaceMembership({ actor: support, workspaceId })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
  });
  isolated("owner-null workspace stays unassigned and global operator cannot infer ownership", async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { supportOwnerUserId: null } });
    await expect(change("FULL")).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).supportOwnerUserId).toBeNull();
  });
  isolated("concurrent owner decisions serialize and leave one audit decision", async () => {
    const results = await Promise.allSettled([change("SETUP"), change("FULL")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    const audits = await prisma.auditLog.findMany({ where: { workspaceId, entityType: "WorkspaceSupportGrant" } });
    expect(audits).toHaveLength(1); expect(audits[0].meta).toMatchObject({ recipientUserId: support.user.id, version: 1 });
  });
  isolated("cached Slack identity rechecks content permission after downgrade", async () => {
    await change("FULL");
    const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } });
    const teamId = randomUUID();
    const installation = await prisma.communicationInstallation.create({ data: { workspaceId, provider: "SLACK", externalWorkspaceId: teamId, status: "ACTIVE" } });
    await prisma.communicationExternalUser.create({ data: { installationId: installation.id, workspaceId, provider: "SLACK", externalUserId: "synthetic", userId: support.user.id, memberId: member.id } });
    await change("SETUP", 1);
    const response = await handleSlackCommand(new URLSearchParams({ team_id: teamId, user_id: "synthetic", text: "brief" }));
    expect(JSON.stringify(response)).not.toContain("Open actions");
  });
  isolated("a grant in one workspace never revokes independent membership elsewhere", async () => {
    const other = await prisma.workspace.create({ data: { slug: randomUUID(), name: "Independent fixture" } }); workspaces.push(other.id);
    await prisma.member.create({ data: { workspaceId: other.id, userId: support.user.id, role: "ADMIN", kind: "HUMAN" } });
    await change("SETUP");
    await expect(requireWorkspaceMembership({ actor: support, workspaceId: other.id })).resolves.toMatchObject({ role: "ADMIN" });
    await expect(requireWorkspaceMembership({ actor: support, workspaceId })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
  });
  for (const kind of ["user", "agent"] as const) for (const operation of ["issue", "rotate"] as const) {
    isolated(`${kind} ${operation} cannot persist a credential for a grant renewed during its lookup`, async () => {
      await change("FULL");
      const actor: AppActor = kind === "user" ? support : { kind: "agent", label: "Synthetic delegation", authProvider: "credential", workspaceIds: [workspaceId], scopes: ["support:write"], supportOrigin: { userId: support.user.id, workspaceId, version: 1 } };
      const catalog = await prisma.catalogItem.create({ data: { workspaceId, type: "TOOL", title: "Synthetic capability", slug: randomUUID() } });
      const credential = await prisma.agentCredential.create({ data: { workspaceId, createdByUserId: support.user.id, supportGrantVersion: 1, label: "Synthetic original", tokenHash: randomUUID(), scopes: ["brain:read"] } });
      const renewGrant = async () => {
        expect(getSupportAuthorizationContext()?.origin).toEqual({ userId: support.user.id, workspaceId, version: 1 });
        await change("FULL", 1, false);
        await change("FULL", 2);
      };
      capabilityLookup.model = operation === "issue" ? "CatalogItem" : "AgentCredential";
      capabilityLookup.run = renewGrant;
      try {
        await expect(runWithSupportOrigin(undefined, () => operation === "issue"
          ? issueAgentCredential(actor, { workspaceId, label: "Stale request", catalogItemId: catalog.id })
          : rotateAgentCredential(actor, { workspaceId, credentialId: credential.id }))).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
      } finally {
        capabilityLookup.run = undefined;
      }
      expect(await prisma.agentCredential.count({ where: { workspaceId } })).toBe(1);
      expect(await prisma.agentCredential.findUnique({ where: { id: credential.id } })).toMatchObject({ tokenHash: credential.tokenHash, supportGrantVersion: 1, isActive: false });
      expect(await prisma.workspaceSupportGrant.findUnique({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } } })).toMatchObject({ version: 3, role: "FULL", isActive: true });
    });
  }
  isolated("named Full support does not consume the final customer trial seat, but its ordinary membership elsewhere does", async () => {
    const trial = (id: string) => prisma.procurementTrial.create({ data: {
      workspaceId: id, status: "ACTIVE", companyName: "Synthetic seat trial", adminEmail: `trial-${id}@example.test`,
      emailDomain: `${id}.example.test`, acceptedTermsVersion: "synthetic", trialExpiresAt: new Date(Date.now() + 60_000), memberLimit: 2,
    } });
    await trial(workspaceId);
    await change("FULL");
    expect(await prisma.member.count({ where: { workspaceId, isActive: true } })).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: support.user.id } })).isSupportAccount).toBe(false);
    await expect(assertTrialMemberCapacity(workspaceId)).resolves.toBeUndefined();
    const customer = await prisma.user.create({ data: { email: `customer-seat-${randomUUID()}@example.test`, passwordHash: "synthetic" } }); users.push(customer.id);
    await createMember(owner, { workspaceId, email: customer.email, role: "CONTRIBUTOR" });
    await expect(assertTrialMemberCapacity(workspaceId)).rejects.toMatchObject({ code: "TRIAL_MEMBER_LIMIT_EXCEEDED" });

    const other = await prisma.workspace.create({ data: { slug: randomUUID(), name: "Ordinary membership seat fixture", supportOwnerUserId: owner.user.id } }); workspaces.push(other.id);
    await prisma.member.createMany({ data: [owner, support].map(actor => ({ workspaceId: other.id, userId: actor.user.id, role: "ADMIN", kind: "HUMAN" })) });
    await trial(other.id);
    await expect(assertTrialMemberCapacity(other.id)).rejects.toMatchObject({ code: "TRIAL_MEMBER_LIMIT_EXCEEDED" });
  });
  isolated("Setup changes actual workspace settings, invitation policy and budget without reading content", async () => {
    await change("SETUP");
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "workspace", name: "Configured workspace", description: "write-only-description-canary" });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_REQUEST" });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "budget", monthlyCostCapUsd: 75, alertThresholdPct: 70, periodStartDay: 5 });
    const dto = await getSupportConfiguration(support, workspaceId);
    expect(dto).toMatchObject({ workspace: { name: "Configured workspace" }, invitePolicy: "MEMBERS_CAN_REQUEST", budget: { monthlyCostCapUsd: 75, alertThresholdPct: 70, periodStartDay: 5 } });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).description).toBe("write-only-description-canary");
    expect(JSON.stringify(dto)).not.toContain("canary");
    expect(await prisma.auditLog.count({ where: { workspaceId, action: { startsWith: "support.configuration." } } })).toBe(3);
    await expect(listBrainSources(support, { workspaceId })).rejects.toMatchObject({ status: 403 });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "workspace", name: "bad", supportOwnerUserId: support.user.id })).rejects.toThrow();
    await change("SETUP", 1, false);
    await expect(getSupportConfiguration(support, workspaceId)).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "workspace", name: "bad" })).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });
  isolated("Setup requests owner authorization for membership and promotion, while retaining safe reductions", async () => {
    await change("SETUP");
    const ordinary = await prisma.user.create({ data: { email: `ordinary-${randomUUID()}@example.test`, passwordHash: "password-canary" } }); users.push(ordinary.id);
    const add = await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: ordinary.email, role: "CONTRIBUTOR" });
    expect(add).toMatchObject({ saved: false, approvalRequired: true });
    await expect(listBrainSources({ kind: "user", user: ordinary }, { workspaceId })).rejects.toMatchObject({ status: 403 });
    await decideSupportAccessRequest(owner, workspaceId, add.requestId!, true);
    const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: ordinary.id } } });
    const promote = await changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: member.id, role: "ADMIN", isActive: true });
    expect(await prisma.member.findUnique({ where: { id: member.id } })).toMatchObject({ role: "CONTRIBUTOR" });
    await decideSupportAccessRequest(owner, workspaceId, promote.requestId!, true);
    expect(await prisma.member.findUnique({ where: { id: member.id } })).toMatchObject({ role: "ADMIN", isActive: true });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: member.id, role: "ADMIN", isActive: false });
    expect(await prisma.member.findUnique({ where: { id: member.id } })).toMatchObject({ isActive: false });
    const ownerMember = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: owner.user.id } } });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: ownerMember.id, role: "CONTRIBUTOR", isActive: false })).rejects.toMatchObject({ code: "SUPPORT_OWNER_PROTECTED" });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: support.user.email, role: "ADMIN" })).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: member.id, role: "ADMIN", isActive: true, email: support.user.email })).rejects.toThrow();
    expect(JSON.stringify(await getSupportConfiguration(support, workspaceId))).not.toContain("password-canary");
    expect(await prisma.session.count({ where: { userId: ordinary.id } })).toBe(0);
  });
  isolated("Setup controls consented integrations and recorder preferences with scrubbed DTOs and unchanged source boundaries", async () => {
    await change("SETUP");
    const connection = await prisma.oAuthConnection.create({ data: { workspaceId, userId: owner.user.id, provider: "GOOGLE", providerAccountId: "account-canary", providerEmail: "private-provider-canary@example.test", accessToken: "token-canary", scopes: ["https://www.googleapis.com/auth/drive.readonly"], syncSettings: { documents: { enabled: true, selectedDriveIds: ["document-canary"] }, email: { filters: ["message-filter-canary"] }, calendar: { enabled: false } }, lastSyncError: "raw-error-canary" } });
    const installation = await prisma.communicationInstallation.create({ data: { workspaceId, provider: "SLACK", externalWorkspaceId: randomUUID(), botTokenEnc: "bot-token-canary", settings: { channelAdmissionMode: "selected", publicIngestionEnabled: false, rawRetentionDays: 30, privateContent: "message-canary" } } });
    await prisma.workspaceMeetingRecorderConfig.create({ data: { workspaceId, enabled: false, autoRecordEnabled: false, botName: "bot-canary", entryMessage: "entry-canary", providerSettings: { key: "credential-canary" } } });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "oauth", connectionId: connection.id, status: "PAUSED", calendar: false, documents: false, email: false });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "oauth", connectionId: connection.id, status: "ACTIVE", calendar: false, documents: true, email: false });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "oauth", connectionId: connection.id, status: "ACTIVE", calendar: true, documents: true, email: false })).rejects.toMatchObject({ code: "OWNER_SELECTION_REQUIRED" });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "communication", installationId: installation.id, rawRetentionDays: 14 });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "recorder", defaultProvider: "MEETING_BAAS", fallbackProvider: null, monthlyMinuteCap: 1200, botName: "Configured recorder" });
    const dto = await getSupportConfiguration(support, workspaceId);
    expect(JSON.stringify(dto)).not.toContain("canary");
    expect(dto.recorder).toMatchObject({ enabled: false, autoRecordEnabled: false, defaultProvider: "MEETING_BAAS", monthlyMinuteCap: 1200 });
    expect(await prisma.oAuthConnection.findUnique({ where: { id: connection.id } })).toMatchObject({ accessToken: "token-canary", userId: owner.user.id, syncSettings: { documents: { selectedDriveIds: ["document-canary"] } } });
    expect(await prisma.communicationInstallation.findUnique({ where: { id: installation.id } })).toMatchObject({ settings: { channelAdmissionMode: "selected", publicIngestionEnabled: false, rawRetentionDays: 14 } });
    expect(await prisma.workflowJob.count({ where: { workspaceId } })).toBe(0);
    await prisma.oAuthConnection.update({ where: { id: connection.id }, data: { status: "DISCONNECTED" } });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "oauth", connectionId: connection.id, status: "ACTIVE", calendar: false, documents: true, email: false })).rejects.toMatchObject({ code: "OWNER_CONSENT_REQUIRED" });
  });
  isolated("configuration writes reject cross-tenant targets, stale grants and authority-expanding fields", async () => {
    await change("SETUP");
    await expect(changeSupportConfiguration(support, workspaceId, 999, { kind: "workspace", name: "bad" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: "other-workspace", role: "ADMIN", isActive: true })).rejects.toMatchObject({ code: "MEMBER_UNAVAILABLE" });
    for (const input of [{ kind: "sso", clientSecret: "no" }, { kind: "oauth", connectionId: "other", status: "ACTIVE", calendar: false, documents: false, email: false, url: "https://untrusted.example" }, { kind: "recorder", defaultProvider: "RECALL_AI", fallbackProvider: null, monthlyMinuteCap: 1, enabled: true }]) {
      await expect(changeSupportConfiguration(support, workspaceId, 1, input)).rejects.toThrow();
    }
    await expect(getSupportConfiguration(owner, workspaceId)).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });
  isolated("new invitations create neither account nor credentials until owner approval and never disclose credentials", async () => {
    await change("SETUP");
    const email = `invited-${randomUUID()}@example.test`;
    const request = await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email, role: "CONTRIBUTOR" });
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(setupEmail).not.toHaveBeenCalled();
    const result = await decideSupportAccessRequest(owner, workspaceId, request.requestId!, true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } }); users.push(user.id);
    expect(result).toEqual({ approved: true, invitation: "sent" });
    expect(setupEmail).toHaveBeenCalledTimes(1);
    expect(setupEmail.mock.calls[0][0]).toMatchObject({ email, workspaceId });
    expect(JSON.stringify(result)).not.toContain(setupEmail.mock.calls[0][0].token);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email, role: "ADMIN" })).rejects.toMatchObject({ code: "EXISTING_MEMBERSHIP" });
    expect(setupEmail).toHaveBeenCalledTimes(1);
    setupEmail.mockResolvedValue({ sent: false, error: "private-provider-error-canary" });
    const failedEmail = `delivery-${randomUUID()}@example.test`;
    const failedRequest = await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: failedEmail, role: "CONTRIBUTOR" });
    const failedResult = await decideSupportAccessRequest(owner, workspaceId, failedRequest.requestId!, true);
    users.push((await prisma.user.findUniqueOrThrow({ where: { email: failedEmail } })).id);
    expect(failedResult).toEqual({ approved: true, invitation: "unavailable" });
    expect(JSON.stringify(failedResult)).not.toContain("canary");
  });
  isolated("alternate accounts cannot read canary or retain unapproved delegation after Setup revocation", async () => {
    await change("SETUP");
    const alternate = await prisma.user.create({ data: { email: `alternate-${randomUUID()}@example.test`, passwordHash: "synthetic" } }); users.push(alternate.id);
    const alternateActor: AppActor = { kind: "user", user: alternate };
    const requests: string[] = [];
    for (const role of ["ADMIN", "CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD"] as const) {
      const result = await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: alternate.email, role });
      expect(result).toMatchObject({ saved: false, approvalRequired: true }); requests.push(result.requestId!);
      await expect(listBrainSources(alternateActor, { workspaceId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(decideSupportAccessRequest(support, workspaceId, requests[0], true)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await expect(decideSupportAccessRequest(alternateActor, workspaceId, requests[0], true)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await change("SETUP", 1, false);
    for (const id of requests) await expect(decideSupportAccessRequest(owner, workspaceId, id, true)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(listBrainSources(alternateActor, { workspaceId })).rejects.toMatchObject({ status: 403 });
    expect(await prisma.member.count({ where: { workspaceId, userId: alternate.id } })).toBe(0);
    await change("SETUP", 2);
    await expect(decideSupportAccessRequest(owner, workspaceId, requests[0], true)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const fresh = await changeSupportConfiguration(support, workspaceId, 3, { kind: "addMember", email: alternate.email, role: "CONTRIBUTOR" });
    await decideSupportAccessRequest(owner, workspaceId, fresh.requestId!, true);
    await change("SETUP", 3, false);
    expect(JSON.stringify(await listBrainSources(alternateActor, { workspaceId }))).toContain("synthetic-content-canary");
    expect(await prisma.workspaceSupportAccessRequest.findUnique({ where: { id: fresh.requestId! } })).toMatchObject({ status: "APPROVED", decidedByUserId: owner.user.id, requestedByUserId: support.user.id, grantVersion: 3 });
    expect(await prisma.auditLog.count({ where: { workspaceId, action: "support.access.approved", entityId: fresh.requestId!, actorUserId: owner.user.id } })).toBe(1);
  });
  isolated("reactivation, lateral roles and invitation authority cannot combine into indirect Setup escalation", async () => {
    await change("SETUP");
    const alternate = await prisma.user.create({ data: { email: `reactivate-${randomUUID()}@example.test`, passwordHash: "synthetic" } }); users.push(alternate.id);
    const member = await prisma.member.create({ data: { workspaceId, userId: alternate.id, role: "FACILITATOR", isActive: false, kind: "HUMAN" } });
    const activation = await changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: member.id, role: "CONTRIBUTOR", isActive: true });
    expect(activation.approvalRequired).toBe(true);
    await expect(listBrainSources({ kind: "user", user: alternate }, { workspaceId })).rejects.toMatchObject({ status: 403 });
    for (const policy of ["ADMINS_ONLY", "MEMBERS_CAN_REQUEST"] as const) {
      await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy });
      const request = await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_INVITE" });
      expect(request.approvalRequired).toBe(true);
      expect(await prisma.workspaceFeatureFlag.findUnique({ where: { workspaceId_flag: { workspaceId, flag: "MEMBER_INVITES" } } })).toMatchObject({ config: { policy } });
      await expect(createMember({ kind: "user", user: alternate }, { workspaceId, email: `not-created-${randomUUID()}@example.test`, role: "CONTRIBUTOR" })).rejects.toMatchObject({ status: 403 });
    }
    await prisma.member.update({ where: { id: member.id }, data: { isActive: true } });
    await expect(decideSupportAccessRequest(owner, workspaceId, activation.requestId!, true)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    for (const [from, to] of [["FACILITATOR", "FINANCE_STEWARD"], ["FINANCE_STEWARD", "FACILITATOR"]] as const) {
      await prisma.member.update({ where: { id: member.id }, data: { role: from } });
      expect(await changeSupportConfiguration(support, workspaceId, 1, { kind: "member", memberId: member.id, role: to, isActive: true })).toMatchObject({ approvalRequired: true });
      expect(await prisma.member.findUnique({ where: { id: member.id } })).toMatchObject({ role: from });
    }
    const pending = await listSupportAccessRequests(owner, workspaceId);
    await decideSupportAccessRequest(owner, workspaceId, pending[0].id, false);
    await expect(decideSupportAccessRequest(owner, workspaceId, pending[0].id, true)).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE" });
  });
  isolated("Full retains direct ordinary membership and invitation-policy administration", async () => {
    await change("FULL");
    const ordinary = await prisma.user.create({ data: { email: `full-add-${randomUUID()}@example.test`, passwordHash: "synthetic" } }); users.push(ordinary.id);
    expect(await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: ordinary.email, role: "ADMIN" })).toMatchObject({ saved: true, approvalRequired: false });
    expect(await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_INVITE" })).toMatchObject({ saved: true });
    expect(await prisma.workspaceSupportAccessRequest.count({ where: { workspaceId } })).toBe(0);
    expect(JSON.stringify(await listBrainSources({ kind: "user", user: ordinary }, { workspaceId }))).toContain("synthetic-content-canary");
  });
  isolated("event failure rolls back the owner-approved membership and leaves the request retryable", async () => {
    await change("SETUP");
    const ordinary = await prisma.user.create({ data: { email: `rollback-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    users.push(ordinary.id);
    const request = await changeSupportConfiguration(support, workspaceId, 1, { kind: "addMember", email: ordinary.email, role: "CONTRIBUTOR" });
    const emit = vi.spyOn(events, "appendEvents").mockRejectedValueOnce(new Error("synthetic event failure"));
    try {
      await expect(decideSupportAccessRequest(owner, workspaceId, request.requestId!, true)).rejects.toThrow("synthetic event failure");
    } finally {
      emit.mockRestore();
    }
    expect(await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId, userId: ordinary.id } } })).toBeNull();
    expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { workspaceId, action: { in: ["support.access.approved", "support.configuration.addMember"] } } })).toBe(0);
    expect(await prisma.workspaceSupportAccessRequest.findUnique({ where: { id: request.requestId! } })).toMatchObject({ status: "PENDING" });
    await decideSupportAccessRequest(owner, workspaceId, request.requestId!, true);
    expect(await prisma.event.count({ where: { workspaceId, type: "member.created" } })).toBe(1);
  });
  for (const role of ["FULL", "SETUP"] as const) isolated(`${role} member lifecycle reaches context sync through existing event and job authorization`, async () => {
    await change(role);
    const ordinary = await prisma.user.create({ data: { email: `lifecycle-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    users.push(ordinary.id);
    const configure = (command: Parameters<typeof changeSupportConfiguration>[3]) => runWithSupportOrigin(undefined, async () => {
      // Same request boundary as the sanitized configuration API; no invented Full origin.
      await requireSupportRequestAccess(support, `/api/workspaces/${workspaceId}/support-configuration`);
      return changeSupportConfiguration(support, workspaceId, 1, command);
    });
    const apply = async (command: Parameters<typeof changeSupportConfiguration>[3]) => {
      const before = await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } });
      const result = await configure(command);
      if (result.approvalRequired) {
        expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(before);
        await runWithSupportOrigin(undefined, async () => {
          await requireSupportRequestAccess(owner, `/api/workspaces/${workspaceId}/support-access-requests`);
          await decideSupportAccessRequest(owner, workspaceId, result.requestId!, true);
        });
      }
      expect(await prisma.event.count({ where: { workspaceId, aggregateType: "Member" } })).toBe(before + 1);
    };
    const sync = async (memberId: string, type: string, expectedRole: string, active: boolean) => {
      const event = await prisma.event.findFirstOrThrow({ where: { workspaceId, aggregateId: memberId, type } });
      expect(event).toMatchObject({ aggregateType: "Member", supportOriginUserId: null, supportGrantVersion: null, payload: { memberId } });
      const job = await withWorkspaceSupportExecution(event, async () => {
        const derived = deriveJobsForEvent(event).filter(job => job.type === "context-graph.sync");
        expect(derived).toHaveLength(1);
        const { dependsOnDedupeKey: _dependency, ...data } = derived[0];
        return prisma.workflowJob.create({ data });
      });
      await withWorkspaceSupportExecution(job, () => handleContextGraphSync(job.id, job.payload as { sourceType: string; sourceId: string }, workspaceId));
      expect(await prisma.contextGraphObject.findFirst({ where: { workspaceId, sourceEntityType: "Member", sourceEntityId: memberId } })).toMatchObject({
        status: active ? "approved" : "archived", properties: { workspaceRole: expectedRole, isActive: active },
      });
    };
    await apply({ kind: "addMember", email: ordinary.email, role: "CONTRIBUTOR" });
    const member = await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: ordinary.id } } });
    await sync(member.id, "member.created", "CONTRIBUTOR", true);
    await apply({ kind: "member", memberId: member.id, role: "FACILITATOR", isActive: true });
    await sync(member.id, "member.updated", "FACILITATOR", true);
    await apply({ kind: "member", memberId: member.id, role: "FACILITATOR", isActive: false });
    await sync(member.id, "member.deactivated", "FACILITATOR", false);
    await apply({ kind: "member", memberId: member.id, role: "FACILITATOR", isActive: true });
    await sync(member.id, "member.reactivated", "FACILITATOR", true);
    if (role === "SETUP") {
      expect(await prisma.auditLog.count({ where: { workspaceId, actorUserId: owner.user.id, action: "support.access.approved" } })).toBe(3);
      expect(await prisma.auditLog.count({ where: { workspaceId, actorUserId: support.user.id, action: "support.configuration.member" } })).toBe(1);
      await expect(listBrainSources(support, { workspaceId })).rejects.toMatchObject({ code: "SUPPORT_CONTENT_RESTRICTED" });
    }
  });
  isolated("owner decisions bind tenant and policy state, serialize once, and reject non-owner admins", async () => {
    await change("SETUP");
    const request = await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_INVITE" });
    const other = await prisma.workspace.create({ data: { slug: randomUUID(), name: "Other owner workspace", supportOwnerUserId: owner.user.id } }); workspaces.push(other.id);
    await prisma.member.create({ data: { workspaceId: other.id, userId: owner.user.id, role: "ADMIN", kind: "HUMAN" } });
    await expect(decideSupportAccessRequest(owner, other.id, request.requestId!, true)).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE" });
    const nonOwner = await prisma.user.create({ data: { email: `nonowner-${randomUUID()}@example.test`, passwordHash: "synthetic" } }); users.push(nonOwner.id);
    await prisma.member.create({ data: { workspaceId, userId: nonOwner.id, role: "ADMIN", kind: "HUMAN" } });
    await expect(decideSupportAccessRequest({ kind: "user", user: nonOwner }, workspaceId, request.requestId!, true)).rejects.toMatchObject({ code: "SUPPORT_OWNER_REQUIRED" });
    await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_REQUEST" });
    await expect(decideSupportAccessRequest(owner, workspaceId, request.requestId!, true)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const fresh = await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "MEMBERS_CAN_INVITE" });
    const results = await Promise.allSettled([decideSupportAccessRequest(owner, workspaceId, fresh.requestId!, true), decideSupportAccessRequest(owner, workspaceId, fresh.requestId!, true)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { workspaceId, action: "support.access.approved", entityId: fresh.requestId! } })).toBe(1);
    expect(await prisma.workspaceFeatureFlag.findUnique({ where: { workspaceId_flag: { workspaceId, flag: "MEMBER_INVITES" } } })).toMatchObject({ config: { policy: "MEMBERS_CAN_INVITE" } });
    expect(await changeSupportConfiguration(support, workspaceId, 1, { kind: "invitePolicy", policy: "ADMINS_ONLY" })).toMatchObject({ saved: true, approvalRequired: false });
  });
});
