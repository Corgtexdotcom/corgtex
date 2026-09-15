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
