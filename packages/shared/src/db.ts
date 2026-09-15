import { PrismaClient } from "@prisma/client";
import { env } from "./env";
import { getSupportAuthorizationContext } from "./support-context";
import { getMcpOrigin, assertMcpOriginActive } from "./mcp-context";

const createClient = () => {
  const client = new PrismaClient({
    datasources: {
      db: {
        url: env.DATABASE_URL,
      },
    },
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  const extended = client.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const params = { model, action: operation, args: args as Record<string, any> };
    const context = getSupportAuthorizationContext();
    const mcpOrigin = getMcpOrigin();
    if (mcpOrigin && ["Event", "WorkflowJob"].includes(model)
      && ["create", "createMany", "upsert", "update", "updateMany"].includes(operation)) {
      if (["upsert", "update", "updateMany"].includes(operation)) {
        // Bind the existing row atomically, including id-only updates and upserts.
        params.args.where = { ...params.args.where, AND: [params.args.where, { workspaceId: mcpOrigin.workspaceId }] };
      }
      const rows = operation === "upsert" ? [params.args.create, params.args.update]
        : Array.isArray(params.args.data) ? params.args.data : [params.args.data];
      for (const row of rows) {
        if (operation === "upsert" && row === params.args.update && Object.keys(row).length === 0) continue;
        const workspaceId = row.workspaceId ?? row.workspace?.connect?.id
          ?? (["update", "updateMany"].includes(operation) || row === params.args.update ? mcpOrigin.workspaceId : undefined);
        if (typeof workspaceId !== "string") throw new Error("MCP_AUTHORIZATION_REVOKED");
        await assertMcpOriginActive(client, mcpOrigin, workspaceId);
        row.mcpOrigin = mcpOrigin;
      }
    }
    if (!context?.supportUserId || !["Event", "WorkflowJob"].includes(params.model ?? "")
      || !["create", "createMany", "upsert", "update", "updateMany"].includes(params.action)) return query(args);
    const rows = params.action === "upsert"
      ? [params.args.create, params.args.update]
      : Array.isArray(params.args.data) ? params.args.data : [params.args.data];
    for (const row of rows) {
      if (params.action === "upsert" && row === params.args.update && Object.keys(row).length === 0) continue;
      let workspaceId = row.workspaceId ?? row.workspace?.connect?.id ?? params.args.create?.workspaceId ?? context.origin?.workspaceId;
      if (!workspaceId && params.args.where?.id) {
        const existing = params.model === "Event"
          ? await client.event.findUnique({ where: { id: params.args.where.id }, select: { workspaceId: true } })
          : await client.workflowJob.findUnique({ where: { id: params.args.where.id }, select: { workspaceId: true } });
        workspaceId = existing?.workspaceId;
      }
      if (!workspaceId) throw new Error("SUPPORT_WORKSPACE_REQUIRED");
      const grant = await client.workspaceSupportGrant.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: context.supportUserId } },
        select: { isActive: true, role: true, version: true },
      });
      if (!grant?.isActive || grant.role !== "FULL" || (context.origin && (context.origin.workspaceId !== workspaceId || context.origin.version !== grant.version))) {
        throw new Error("SUPPORT_AUTHORIZATION_REVOKED");
      }
      row.supportOriginUserId = context.supportUserId;
      row.supportGrantVersion = grant.version;
    }
    return query(args);
  } } } });
  return extended as unknown as PrismaClient;
};

declare global {
  var prismaGlobal: PrismaClient | undefined;
  var prismaGlobalUrl: string | undefined;
}

function getClientStore() {
  return globalThis as typeof globalThis & {
    prismaGlobal?: PrismaClient;
    prismaGlobalUrl?: string;
  };
}

let prismaClient: PrismaClient | undefined;
let prismaClientUrl: string | undefined;

export function getPrismaClient() {
  const globalStore = getClientStore();
  const databaseUrl = env.DATABASE_URL;

  if (prismaClient && prismaClientUrl === databaseUrl) {
    return prismaClient;
  }

  if (prismaClient && prismaClientUrl !== databaseUrl) {
    void prismaClient.$disconnect();
    prismaClient = undefined;
    prismaClientUrl = undefined;
  }

  if (env.NODE_ENV !== "production" && globalStore.prismaGlobal && globalStore.prismaGlobalUrl === databaseUrl) {
    prismaClient = globalStore.prismaGlobal;
    prismaClientUrl = globalStore.prismaGlobalUrl;
    return prismaClient;
  }

  prismaClient = createClient();
  prismaClientUrl = databaseUrl;

  if (env.NODE_ENV !== "production") {
    globalStore.prismaGlobal = prismaClient;
    globalStore.prismaGlobalUrl = databaseUrl;
  }

  return prismaClient;
}

// Delay client creation until code actually needs a DB call so builds can
// import domain modules without requiring a live DATABASE_URL.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;
