import type { Prisma } from "@prisma/client";
export function createFreshDemoSeedWorkspace(tx: Prisma.TransactionClient, data: {slug: string; name: string; description: string}): Promise<{workspace: {id: string}; token: object}>;
export function settleFreshDemoInitialization(tx: Prisma.TransactionClient, token: object, fixture: {userIds: string[]; emails: string[]; circleIds: string[]; roleIds: string[]; assignments: {roleId: string; memberId: string}[]}): Promise<void>;
