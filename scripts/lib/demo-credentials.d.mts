import type { PrismaClient } from "@prisma/client";

export function assertDemoCredentialsScoped(prisma: PrismaClient, workspaceId: string | undefined, userIds: string[]): Promise<void>;
export function revokeDemoCredentials(prisma: PrismaClient, workspaceId: string, userIds: string[]): Promise<void>;

export function assertDemoWorkspaceDisconnected(prisma: PrismaClient, workspaceId: string | undefined, userIds?: string[]): Promise<void>;
