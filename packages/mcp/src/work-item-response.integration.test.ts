import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, mcpScopesHash, captureMcpOAuthGrantEpoch, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "../../domain/src/source-lineage";
import * as audit from "../../domain/src/audit-trail";
import * as mcpContext from "../../shared/src/mcp-context";
import type { Prisma } from "@prisma/client";
import { createCorgtexMcpServer } from "./server";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(active = false) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic MCP response", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const holder = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Holder canary" } });
  const holderMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: holder.id, role: "CONTRIBUTOR", isActive: active } });
  const actor: AppActor = { kind: "user", user };
  const action = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: user.id, title: "Original action", bodyMd: "Original body", status: "OPEN", isPrivate: false, assigneeMemberId: holderMember.id } });
  const tension = await prisma.tension.create({ data: { workspaceId: workspace.id, authorUserId: user.id, title: "Original tension", bodyMd: "Original body", status: "OPEN", isPrivate: false, assigneeMemberId: holderMember.id, raisedByMemberId: holderMember.id } });
  await prisma.tensionUpvote.create({ data: { tensionId: tension.id, userId: holder.id } });
  for (const [kind, row] of [["Action", action], ["Tension", tension]] as const) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const scopes = ["actions:read", "actions:write", "tensions:read", "tensions:write", "members:read"];
  const client = await prisma.mcpOAuthClient.create({ data: { clientId: randomUUID(), name: "Synthetic response reader", redirectUris: ["https://synthetic.example.test"], scopes } });
  const token = await prisma.mcpOAuthAccessToken.create({ data: { workspaceId: workspace.id, userId: user.id, clientId: client.id, instanceSlug: "selfserve", tokenHash: randomUUID(), scopes,
    expiresAt: new Date(Date.now() + 600_000), refreshExpiresAt: new Date(Date.now() + 3_600_000) } });
  const grantEpoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, workspace.id, token.id));
  const server = createCorgtexMcpServer({ workspaceId: workspace.id, actor, authKind: "oauth", scopes,
    mcpOrigin: { kind: "oauth", id: token.id, workspaceId: workspace.id, scopeHash: mcpScopesHash(scopes), grantEpoch } });
  const call = async (kind: "Action" | "Tension", create = false) => {
    const name = `${create ? "create" : "update"}_${kind.toLowerCase()}`;
    const args = create ? { title: `Created ${kind}`, assigneeMemberId: holderMember.id,
      ...(kind === "Tension" ? { raisedByMemberId: holderMember.id } : {}) }
      : { [kind === "Action" ? "actionId" : "tensionId"]: kind === "Action" ? action.id : tension.id, expectedVersion: 1, priority: 2 };
    const result = await (server as any)._registeredTools[name].handler(args);
    return JSON.parse(result.content[0].text);
  };
  return { workspace, actor, member, holder, holderMember, action, tension, token, call };
}

describe("MCP work item response release", () => {
  it.each(["Action", "Tension"] as const)("redacts inactive joined members from committed %s mutation response", async kind => {
    const f = await fixture();
    const result = await f.call(kind);
    expect(result).toMatchObject({ id: kind === "Action" ? f.action.id : f.tension.id, version: 2, assigneeMemberId: null, assigneeMemberName: null });
    if (kind === "Tension") expect(result).toMatchObject({ raisedByMemberId: null, raisedByMemberName: null, upvoteCount: 0 });
    expect(JSON.stringify(result)).not.toContain("Holder canary");
  });
  it.each(["Action", "Tension"] as const)("retains readable %s labels and create permalink", async kind => {
    const f = await fixture(true);
    const updated = await f.call(kind);
    expect(updated).toMatchObject({ version: 2, assigneeMemberId: f.holderMember.id, assigneeMemberName: "Holder canary" });
    if (kind === "Tension") expect(updated).toMatchObject({ raisedByMemberId: f.holderMember.id, raisedByMemberName: "Holder canary", upvoteCount: 1 });
    const created = await f.call(kind, true);
    expect(created).toMatchObject({ version: 1, assigneeMemberId: f.holderMember.id, assigneeMemberName: "Holder canary", webUrl: expect.stringContaining(`/workspaces/${f.workspace.id}/`), permanentUrl: expect.stringContaining(`/workspaces/${f.workspace.id}/items/`) });
    expect(created.id).toBeTruthy();
  });

  it.each([
    ["Action", "member"], ["Tension", "user"], ["Action", "caller"], ["Tension", "restore"], ["Action", "head"], ["Tension", "vote"],
  ] as const)("rejects %s original response after %s changes during execution audit", async (kind, change) => {
    const f = await fixture(true);
    const original = audit.recordAudit;
    let changed = false;
    vi.spyOn(audit, "recordAudit").mockImplementation(async (tx, actor, params) => {
      const result = await original(tx, actor, params);
      if (params.action === "mcp.tool_executed" && !changed) {
        changed = true;
        if (change === "head") {
          const head = await tx.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, artifactType: kind, artifactId: f.action.id }, orderBy: { revision: "desc" } });
          await tx.artifactInputLineage.update({ where: { id: head.id }, data: { revision: { increment: 1 } } });
        }
        else if (change === "vote") await tx.tensionUpvote.deleteMany({ where: { tensionId: f.tension.id } });
        else if (change === "user") await tx.user.update({ where: { id: f.holder.id }, data: { displayName: "Changed after capture" } });
        else {
          const id = change === "caller" ? f.member.id : f.holderMember.id;
          await tx.member.update({ where: { id }, data: { isActive: false } });
          if (change === "restore") await tx.member.update({ where: { id }, data: { isActive: true } });
        }
      }
      return result;
    });
    await expect(f.call(kind)).rejects.toThrow();
    expect(changed).toBe(true);
    const row = kind === "Action" ? await prisma.action.findUniqueOrThrow({ where: { id: f.action.id } }) : await prisma.tension.findUniqueOrThrow({ where: { id: f.tension.id } });
    expect(row.version).toBe(2);
  });

  it.each(["Action", "Tension"] as const)("rejects %s create response when a member changes during the actual permalink read", async kind => {
    const f = await fixture(true);
    const original = prisma.workspacePermalink.findUnique.bind(prisma.workspacePermalink);
    let changed = false;
    vi.spyOn(prisma.workspacePermalink, "findUnique").mockImplementation((async args => {
      const result = await original(args);
      if (!changed) {
        changed = true;
        await prisma.member.update({ where: { id: f.holderMember.id }, data: { isActive: false } });
      }
      return result;
    }) as typeof prisma.workspacePermalink.findUnique);
    await expect(f.call(kind, true)).rejects.toThrow();
    expect(changed).toBe(true);
  });

  it.each([false, true])("withholds a missing canonical row and rechecks caller after audit (revoked=%s)", async revoked => {
    const f = await fixture(true);
    const originalRead = prisma.action.findFirst.bind(prisma.action);
    vi.spyOn(prisma.action, "findFirst").mockImplementation((async args => {
      if (args?.include?.assigneeMember) return null;
      return originalRead(args);
    }) as typeof prisma.action.findFirst);
    const originalAudit = audit.recordAudit;
    let audited = false;
    vi.spyOn(audit, "recordAudit").mockImplementation(async (tx, actor, params) => {
      const result = await originalAudit(tx, actor, params);
      if (params.action === "mcp.tool_executed") {
        audited = true;
        if (revoked) await tx.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      }
      return result;
    });
    if (revoked) await expect(f.call("Action")).rejects.toThrow();
    else expect(await f.call("Action")).toEqual({ id: f.action.id, contentWithheld: true });
    expect(audited).toBe(true);
    expect((await prisma.action.findUniqueOrThrow({ where: { id: f.action.id } })).version).toBe(2);
  });

  it("rejects original joined labels changed during the real outer post-call scope check", async () => {
    const f = await fixture(true);
    const original = mcpContext.withMcpRequiredScopes;
    let returned = false;
    let changed = false;
    let scopeCalls = 0;
    vi.spyOn(mcpContext, "withMcpRequiredScopes").mockImplementation(async (db, origin, scopes, run) => {
      if (scopeCalls++ > 0) return original(db, origin, scopes, run);
      const instrument = (tx: Prisma.TransactionClient): Prisma.TransactionClient => new Proxy(tx, {
        get(target, key) {
          if (key === "$transaction" && typeof Reflect.get(target, key) === "function") return async (callback: (inner: Prisma.TransactionClient) => Promise<unknown>) => prisma.$transaction(inner => callback(instrument(inner)));
          if (key !== "mcpOAuthAccessToken") return Reflect.get(target, key);
          return new Proxy(target.mcpOAuthAccessToken, { get(delegate, operation) {
            if (operation !== "findUnique") return Reflect.get(delegate, operation);
            return async (args: Parameters<typeof delegate.findUnique>[0]) => {
              const result = await delegate.findUnique(args);
              if (returned && !changed) {
                changed = true;
                await prisma.user.update({ where: { id: f.holder.id }, data: { displayName: "Changed during outer scope read" } });
              }
              return result;
            };
          } });
        },
      });
      return original(instrument(db), origin, scopes, async () => {
        const result = await run();
        returned = true;
        return result;
      });
    });
    await expect(f.call("Action")).rejects.toThrow();
    expect(changed).toBe(true);
  });
});
