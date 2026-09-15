// Fixture refresh must never adopt a workspace with real external integrations.
export async function assertDemoWorkspaceDisconnected(prisma, workspaceId, userIds = []) {
  if (!workspaceId) return;
  for (const model of ["workspaceSsoConfig", "meetingTranscriptSourceConnection", "communicationInstallation",
    "workspaceRecorderCalendarSource", "oAuthConnection", "externalMcpConnection", "aiWorkspaceConnection", "appInstallation",
    "externalDataSource", "webhookEndpoint", "selfServeSupportSession", "procurementSetupSession", "procurementTrial"]) {
    if (await prisma[model].count({ where: { workspaceId } })) {
      throw new Error(`Existing demo has ${model}; review external access before refresh`);
    }
  }
  if (await prisma.workspaceToolLink.count({ where: { workspaceId, credentialSecretEnc: { not: null } } })) {
    throw new Error("Existing demo has a credentialed tool; review external access before refresh");
  }
  for (const [model, field] of [["oAuthAuthorizationCode", "userId"], ["oAuthAccessToken", "userId"],
    ["mcpOAuthAuthorizationCode", "userId"], ["mcpOAuthAccessToken", "userId"], ["appSession", "actorUserId"], ["agentCredential", "createdByUserId"]]) {
    if (await prisma[model].count({ where: { workspaceId, ...(["appSession", "agentCredential"].includes(model) ? { OR: [{ [field]: { notIn: userIds } }, { [field]: null }] } : { [field]: { notIn: userIds } }) } })) {
      throw new Error("Existing demo has non-fixture credentials; review external access before refresh");
    }
  }
  if (await prisma.workspaceMeetingRecorderConfig.count({ where: { workspaceId, OR: [{ enabled: true }, { autoRecordEnabled: true }] } })) {
    throw new Error("Existing demo has an enabled recorder; review external access before refresh");
  }
}

// Only reserved synthetic identities are passed here, after membership/role checks.
export async function assertDemoCredentialsScoped(prisma, workspaceId, userIds) {
  if (!userIds.length) return;
  for (const [model, field] of [["oAuthAuthorizationCode", "userId"], ["oAuthAccessToken", "userId"],
    ["mcpOAuthAuthorizationCode", "userId"], ["mcpOAuthAccessToken", "userId"],
    ["appSession", "actorUserId"], ["agentCredential", "createdByUserId"]]) {
    if (await prisma[model].count({ where: { [field]: { in: userIds }, ...(workspaceId ? { workspaceId: { not: workspaceId } } : {}) } })) {
      throw new Error("Demo identities have credentials outside the confirmed demo workspace");
    }
  }
  if (await prisma.workspaceSupportGrant.count({ where: { userId: { in: userIds }, isActive: true, ...(workspaceId ? { workspaceId: { not: workspaceId } } : {}) } })) {
    throw new Error("Demo identities have support access outside the confirmed demo workspace");
  }
  if (await prisma.userSsoIdentity.count({ where: { userId: { in: userIds } } })) {
    throw new Error("Demo identities must not retain personal SSO identities");
  }
  if (await prisma.oAuthConnection.count({ where: { userId: { in: userIds } } })
    || await prisma.externalMcpConnection.count({ where: { userId: { in: userIds } } })
    || await prisma.aiWorkspaceConnection.count({ where: { OR: [{ ownerUserId: { in: userIds } }, { createdByUserId: { in: userIds } }] } })) {
    throw new Error("Demo identities must not own personal provider connections");
  }
}

export async function revokeDemoCredentials(prisma, workspaceId, userIds) {
  const now = new Date();
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.oAuthAuthorizationCode.deleteMany({ where: { workspaceId, userId: { in: userIds } } }),
    prisma.mcpOAuthAuthorizationCode.deleteMany({ where: { workspaceId, userId: { in: userIds } } }),
    prisma.oAuthAccessToken.updateMany({ where: { workspaceId, userId: { in: userIds } }, data: { revokedAt: now } }),
    prisma.mcpOAuthAccessToken.updateMany({ where: { workspaceId, userId: { in: userIds } }, data: { revokedAt: now } }),
    prisma.appSession.updateMany({ where: { workspaceId, actorUserId: { in: userIds } }, data: { revokedAt: now } }),
    prisma.agentCredential.updateMany({ where: { workspaceId, createdByUserId: { in: userIds } }, data: { isActive: false } }),
    prisma.oAuthApp.updateMany({ where: { workspaceId }, data: { isActive: false } }),
  ]);
}
