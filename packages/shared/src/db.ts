import { PrismaClient } from "@prisma/client";
import { env } from "./env";

const createClient = () =>
  new PrismaClient({
    datasources: {
      db: {
        url: env.DATABASE_URL,
      },
    },
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

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
