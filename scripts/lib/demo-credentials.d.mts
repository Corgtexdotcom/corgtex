import type { Prisma, PrismaClient } from "@prisma/client";

export function assertDemoCredentialsScoped(prisma: PrismaClient | Prisma.TransactionClient, workspaceId: string | undefined, userIds: string[]): Promise<void>;
export function revokeDemoCredentials(prisma: PrismaClient | Prisma.TransactionClient, workspaceId: string, userIds: string[], options?: {inTransaction?: boolean}): Promise<void>;

export function assertDemoWorkspaceDisconnected(prisma: PrismaClient | Prisma.TransactionClient, workspaceId: string | undefined, userIds?: string[]): Promise<void>;

export const DISABLED_DEMO_PERSONA_PASSWORD_HASH: string;
export function assertDemoPersonasQuiesced(prisma: PrismaClient | Prisma.TransactionClient, users: {id: string; email: string; passwordHash: string}[], publicEmail: string, workspaceId: string | undefined): Promise<void>;
