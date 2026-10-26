import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@corgtex/shared";
import { assertDemoCredentialsScoped, assertDemoWorkspaceDisconnected, revokeDemoCredentials } from "../../../scripts/lib/demo-credentials.mjs";

describe("demo legacy credential retirement", () => {
  it("revokes access and refresh credentials, consumes codes, and refuses credentials outside the target", async () => {
    const key = randomUUID();
    const workspace = await prisma.workspace.create({ data: { slug: `demo-retirement-${key}`, name: "Synthetic demo retirement" } });
    const other = await prisma.workspace.create({ data: { slug: `demo-other-${key}`, name: "Synthetic isolation sentinel" } });
    const user = await prisma.user.create({ data: { email: `demo-${key}@validation.example`, passwordHash: "unused" } });
    const expiresAt = new Date(Date.now() + 60_000);
    let clientId: string | undefined;
    let definitionId: string | undefined;
    try {
      const pendingEvent = await prisma.event.create({ data: { workspaceId: workspace.id, type: "synthetic.pending", payload: {} } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      await prisma.event.delete({ where: { id: pendingEvent.id } });
      const runningJob = await prisma.workflowJob.create({ data: { workspaceId: workspace.id, type: "synthetic.running", payload: {}, status: "RUNNING", lockedBy: "synthetic-qa" } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      await prisma.workflowJob.delete({ where: { id: runningJob.id } });
      const completedJob = await prisma.workflowJob.create({ data: { workspaceId: workspace.id, type: "synthetic.completed", payload: {}, status: "COMPLETED" } });
      await assertDemoWorkspaceDisconnected(prisma, workspace.id);
      await prisma.workflowJob.delete({ where: { id: completedJob.id } });
      const sso = await prisma.workspaceSsoConfig.create({ data: { workspaceId: workspace.id, provider: "GOOGLE", clientId: "synthetic", clientSecretEnc: "synthetic", allowedDomains: ["example.test"], isEnabled: true } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("external access");
      await prisma.workspaceSsoConfig.delete({ where: { id: sso.id } });
      const transcript = await prisma.meetingTranscriptSourceConnection.create({ data: { workspaceId: workspace.id, provider: "FATHOM", authMode: "WEBHOOK", webhookSecretEnc: "synthetic" } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("external access");
      await prisma.meetingTranscriptSourceConnection.delete({ where: { id: transcript.id } });
      const meeting = await prisma.meeting.create({ data: { workspaceId: workspace.id, title: "Synthetic scheduled recorder", source: "synthetic", recordedAt: new Date(), participantIds: [] } });
      const recording = await prisma.meetingRecording.create({ data: { workspaceId: workspace.id, meetingId: meeting.id, provider: "RECALL_AI", externalBotId: key, meetingUrl: "https://example.test", status: "SCHEDULED" } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("recording authority");
      const recordingEventId = await prisma.$transaction(async tx => {
        const [{ transactionId }] = await tx.$queryRaw<{ transactionId: string }[]>`SELECT txid_current()::text AS "transactionId"`;
        await tx.meetingRecording.delete({ where: { id: recording.id } });
        return createHash("md5").update(`pun68-permission:${workspace.id}:${transactionId}`).digest("hex");
      });
      // Recorder retirement emits real permission work; neither pending nor
      // dispatched history may be treated as a disconnected workspace.
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      const recordingEvents = await prisma.event.findMany({ where: { workspaceId: workspace.id,
        type: "source-permission.changed", status: "PENDING", id: recordingEventId } });
      expect(recordingEvents).toMatchObject([{ id: recordingEventId, aggregateType: "SourcePermissionEpoch",
        aggregateId: workspace.id, payload: { version: 2, scope: "WORKSPACE" } }]);
      expect(recordingEvents).toHaveLength(1);
      expect(recordingEvents[0].payload).toEqual({ version: 2, scope: "WORKSPACE" });
      const recordingEventIds = recordingEvents.map(event => event.id);
      const dispatched = await prisma.event.updateMany({ where: { workspaceId: workspace.id, type: "source-permission.changed",
        id: { in: recordingEventIds }, status: "PENDING" }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
      expect(dispatched.count).toBe(recordingEventIds.length);
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      // Remove only this synthetic recording's identified events to reach the independent billing negative.
      await prisma.event.deleteMany({ where: { workspaceId: workspace.id, type: "source-permission.changed", id: { in: recordingEventIds } } });
      const billing = await prisma.workspaceBillingProfile.create({ data: { workspaceId: workspace.id, stripeCustomerId: `synthetic-${key}` } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("billing authority");
      await prisma.workspaceBillingProfile.delete({ where: { id: billing.id } });
      const anonymousAgent = await prisma.agentCredential.create({ data: { workspaceId: workspace.id, label: "Synthetic bootstrap", tokenHash: `bootstrap-${key}`, scopes: [] } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id, [user.id])).rejects.toThrow("non-fixture credentials");
      await prisma.agentCredential.delete({ where: { id: anonymousAgent.id } });
      // Removing live authority emits durable rebuild work. The disconnection
      // guard must remain closed until that synthetic work has been settled.
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      const permissionEvents = await prisma.event.findMany({ where: { workspaceId: workspace.id, type: "source-permission.changed", status: "PENDING" } });
      expect(permissionEvents.length).toBeGreaterThan(0);
      await prisma.event.updateMany({ where: { id: { in: permissionEvents.map(event => event.id) } }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
      await expect(assertDemoWorkspaceDisconnected(prisma, workspace.id)).rejects.toThrow("asynchronous authority");
      // This guard intentionally refuses even dispatched history. Remove only
      // these known synthetic events to isolate the credential retirement case.
      await prisma.event.deleteMany({ where: { id: { in: permissionEvents.map(event => event.id) } } });
      await assertDemoWorkspaceDisconnected(prisma, workspace.id);
      const app = await prisma.oAuthApp.create({ data: { workspaceId: workspace.id, clientId: key, clientSecret: "unused", name: "Synthetic legacy app", redirectUris: [], scopes: [] } });
      const client = await prisma.mcpOAuthClient.create({ data: { clientId: key, name: "Synthetic legacy client", redirectUris: [], scopes: [] } });
      clientId = client.id;
      const definition = await prisma.appDefinition.create({ data: { appKey: `retirement-${key}`, title: "Synthetic legacy installation" } });
      definitionId = definition.id;
      const installation = await prisma.appInstallation.create({ data: { workspaceId: workspace.id, appDefinitionId: definition.id } });
      const common = { workspaceId: workspace.id, userId: user.id, expiresAt, scopes: [] };
      const oauth = await prisma.oAuthAccessToken.create({ data: { ...common, appId: app.id, tokenHash: `oauth-${key}`, refreshHash: `oauth-refresh-${key}` } });
      const mcp = await prisma.mcpOAuthAccessToken.create({ data: { ...common, clientId: client.id, instanceSlug: "selfserve", tokenHash: `mcp-${key}`, refreshHash: `mcp-refresh-${key}` } });
      await prisma.oAuthAuthorizationCode.create({ data: { ...common, appId: app.id, code: `oauth-code-${key}`, redirectUri: "http://localhost" } });
      await prisma.mcpOAuthAuthorizationCode.create({ data: { ...common, clientId: client.id, instanceSlug: "selfserve", code: `mcp-code-${key}`, redirectUri: "http://localhost", codeChallenge: key, codeChallengeMethod: "S256" } });
      await prisma.session.create({ data: { userId: user.id, tokenHash: `session-${key}`, expiresAt } });
      const session = await prisma.appSession.create({ data: { workspaceId: workspace.id, appInstallationId: installation.id, actorUserId: user.id, audience: "synthetic", tokenHash: `app-${key}`, expiresAt } });
      const credential = await prisma.agentCredential.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, label: "Synthetic legacy credential", tokenHash: `agent-${key}`, scopes: [] } });
      const outside = await prisma.agentCredential.create({ data: { workspaceId: other.id, createdByUserId: user.id, label: "Synthetic sentinel credential", tokenHash: `outside-${key}`, scopes: [] } });
      await expect(assertDemoCredentialsScoped(prisma, workspace.id, [user.id])).rejects.toThrow("outside");
      expect((await prisma.oAuthAccessToken.findUniqueOrThrow({ where: { id: oauth.id } })).revokedAt).toBeNull();
      expect((await prisma.agentCredential.findUniqueOrThrow({ where: { id: outside.id } })).isActive).toBe(true);
      await prisma.agentCredential.delete({ where: { id: outside.id } });
      const ssoIdentity = await prisma.userSsoIdentity.create({ data: { userId: user.id, provider: "GOOGLE", providerSubjectId: key, email: user.email } });
      await expect(assertDemoCredentialsScoped(prisma, workspace.id, [user.id])).rejects.toThrow("personal SSO");
      await prisma.userSsoIdentity.delete({ where: { id: ssoIdentity.id } });
      const external = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: user.id, providerKey: "synthetic", displayName: "Synthetic provider", serverUrl: "https://example.test", accessTokenEnc: "synthetic" } });
      await expect(assertDemoCredentialsScoped(prisma, workspace.id, [user.id])).rejects.toThrow("personal provider");
      await prisma.externalMcpConnection.delete({ where: { id: external.id } });
      for (const state of [
        { workspaceId: other.id, role: "SETUP" as const, isActive: true },
        { workspaceId: workspace.id, role: "SETUP" as const, isActive: true },
        { workspaceId: workspace.id, role: "FULL" as const, isActive: false },
      ]) {
        const support = await prisma.workspaceSupportGrant.create({ data: { ...state, userId: user.id, grantedByUserId: user.id } });
        await expect(assertDemoCredentialsScoped(prisma, workspace.id, [user.id])).rejects.toThrow("support grants");
        expect(await prisma.workspaceSupportGrant.findUnique({ where: { id: support.id } })).not.toBeNull();
        await prisma.workspaceSupportGrant.delete({ where: { id: support.id } });
      }
      await assertDemoCredentialsScoped(prisma, workspace.id, [user.id]);
      await revokeDemoCredentials(prisma, workspace.id, [user.id]);
      expect((await prisma.oAuthAccessToken.findUniqueOrThrow({ where: { id: oauth.id } })).revokedAt).not.toBeNull();
      expect((await prisma.mcpOAuthAccessToken.findUniqueOrThrow({ where: { id: mcp.id } })).revokedAt).not.toBeNull();
      expect((await prisma.appSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
      expect((await prisma.agentCredential.findUniqueOrThrow({ where: { id: credential.id } })).isActive).toBe(false);
      expect(await prisma.oAuthAuthorizationCode.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.mcpOAuthAuthorizationCode.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
      expect((await prisma.oAuthApp.findUniqueOrThrow({ where: { id: app.id } })).isActive).toBe(false);
    } finally {
      await prisma.oAuthAccessToken.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } });
      await prisma.user.delete({ where: { id: user.id } });
      if (clientId) await prisma.mcpOAuthClient.delete({ where: { id: clientId } });
      if (definitionId) await prisma.appDefinition.delete({ where: { id: definitionId } });
    }
  });
});
