import type { PrismaClient } from "@prisma/client";

export function assertDemoCredentialsScoped(prisma: PrismaClient, workspaceId: string | undefined, userIds: string[]): Promise<void>;
export function revokeDemoCredentials(prisma: PrismaClient, workspaceId: string, userIds: string[]): Promise<void>;

export function assertDemoWorkspaceDisconnected(prisma: PrismaClient, workspaceId: string | undefined, userIds?: string[]): Promise<void>;

export const DISABLED_DEMO_PERSONA_PASSWORD_HASH: string;
export function assertDemoPersonasQuiesced(prisma: PrismaClient, users: {id: string; email: string; passwordHash: string}[], publicEmail: string, workspaceId: string | undefined): Promise<void>;
