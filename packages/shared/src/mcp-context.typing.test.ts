import { describe, expectTypeOf, it } from "vitest";
import type { AgentCredential, Prisma, PrismaClient } from "@prisma/client";
import { assertMcpOriginActive, assertMcpOriginActiveAdvisory, captureMcpOAuthGrantEpoch,
  withMcpRequiredScopes } from "./mcp-context";

type AdvisoryClient = Parameters<typeof assertMcpOriginActiveAdvisory>[0];
type ConfiguredClient = PrismaClient<{ log: ("error" | "warn")[] }>;
type OAuthQuery = Parameters<AdvisoryClient["mcpOAuthAccessToken"]["findUnique"]>[0];

describe("MCP origin database typing boundary", () => {
  it("accepts configured clients and transactions", () => {
    expectTypeOf<PrismaClient>().toExtend<AdvisoryClient>();
    expectTypeOf<ConfiguredClient>().toExtend<AdvisoryClient>();
    expectTypeOf<Prisma.TransactionClient>().toExtend<AdvisoryClient>();
  });

  it("retains the exact queries, generated payloads and raw-query signature", () => {
    expectTypeOf<OAuthQuery>().toEqualTypeOf<{ where: { id: string }; include: { client: true } }>();
    expectTypeOf<{ where: { id: string } }>().not.toExtend<OAuthQuery>();
    expectTypeOf<{ where: { id: string }; include: { client: false } }>().not.toExtend<OAuthQuery>();
    expectTypeOf<Awaited<ReturnType<AdvisoryClient["mcpOAuthAccessToken"]["findUnique"]>>>()
      .toEqualTypeOf<Prisma.McpOAuthAccessTokenGetPayload<{ include: { client: true } }> | null>();
    expectTypeOf<Parameters<AdvisoryClient["agentCredential"]["findUnique"]>[0]>()
      .toEqualTypeOf<{ where: { id: string } }>();
    expectTypeOf<Awaited<ReturnType<AdvisoryClient["agentCredential"]["findUnique"]>>>()
      .toEqualTypeOf<AgentCredential | null>();
    expectTypeOf<AdvisoryClient["$queryRaw"]>().toEqualTypeOf<Prisma.TransactionClient["$queryRaw"]>();
  });

  it("rejects incomplete read capabilities and incomplete authority results", () => {
    expectTypeOf<{}>().not.toExtend<AdvisoryClient>();
    expectTypeOf<Omit<AdvisoryClient, "$queryRaw">>().not.toExtend<AdvisoryClient>();
    expectTypeOf<Omit<AdvisoryClient, "mcpOAuthAccessToken">>().not.toExtend<AdvisoryClient>();
    expectTypeOf<Omit<AdvisoryClient, "agentCredential">>().not.toExtend<AdvisoryClient>();
    type IncompleteAuthorityClient = Omit<AdvisoryClient, "mcpOAuthAccessToken"> & {
      mcpOAuthAccessToken: { findUnique(args: OAuthQuery): PromiseLike<{ id: string } | null> };
    };
    expectTypeOf<IncompleteAuthorityClient>().not.toExtend<AdvisoryClient>();
  });

  it("does not weaken transaction writer ports", () => {
    expectTypeOf<Parameters<typeof assertMcpOriginActive>[0]>().toEqualTypeOf<Prisma.TransactionClient>();
    expectTypeOf<Parameters<typeof captureMcpOAuthGrantEpoch>[0]>().toEqualTypeOf<Prisma.TransactionClient>();
    expectTypeOf<Parameters<typeof withMcpRequiredScopes>[0]>().toEqualTypeOf<Prisma.TransactionClient>();
  });
});
