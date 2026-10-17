import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, mcpCredentialVersion, mcpScopesHash, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { DigestReadRelease } from "../../domain/src/digest-lineage";
import { createCorgtexMcpServer } from "./server";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
it.each([100, 5001])("bounds graph discovery after %i denied rows and freshly releases a filtered tail", async deniedCount => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic graph pagination", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@graph.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR"}});
  const author: AppActor = {kind: "user", user};
  const scopes = ["context-graph:read"];
  const credential = await prisma.agentCredential.create({data: {workspaceId: workspace.id, label: "Synthetic graph reader", tokenHash: randomUUID(), scopes}});
  const actor: AppActor = {kind: "agent", authProvider: "credential", credentialId: credential.id,
    credentialVersion: mcpCredentialVersion(credential.tokenHash), label: credential.label, workspaceIds: [workspace.id], scopes};
  await prisma.contextGraphObject.createMany({data: Array.from({length: deniedCount}, (_, index) => ({
    id: `denied-${String(index).padStart(5,"0")}`, workspaceId: workspace.id, objectType: "A", title: "Unproved synthetic object", status: "approved",
  }))});
  const tail = await prisma.contextGraphObject.create({data: {workspaceId: workspace.id, objectType: "Z", title: "Readable tail", status: "approved", createdByUserId: user.id}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: author, workspaceId: workspace.id,
    artifact: {kind: "ContextGraphObject", id: tail.id}, content: tail, origin: "HUMAN_ORIGINAL", inputs: []}));
  const server = createCorgtexMcpServer({workspaceId: workspace.id, actor, authKind: "agent", scopes,
    mcpOrigin: {kind: "agent", id: credential.id, workspaceId: workspace.id, scopeHash: mcpScopesHash(scopes), credentialVersion: mcpCredentialVersion(credential.tokenHash)}});
  const query = (server as any)._registeredTools.query_context_graph.handler;
  const reads = vi.spyOn(prisma.contextGraphObject, "findMany");
  if (deniedCount > 200) {
    await expect(query({take: 1})).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
  } else {
    const result = await query({take: 1});
    expect(result.structuredContent.objects.map((row: {id: string}) => row.id)).toEqual([tail.id]);
  }
  expect(reads).toHaveBeenCalledTimes(2);
  for (const [args] of reads.mock.calls) expect(args?.take).toBe(100);
  expect(reads.mock.calls[0][0]?.where?.AND).toHaveLength(1);
  expect(reads.mock.calls[1][0]?.where?.AND).toHaveLength(2);
  // A narrower request can reach the tail without scanning the denied history.
  const filtered = await query({take: 1, objectType: "Z"});
  expect(filtered.structuredContent.objects.map((row: {id: string}) => row.id)).toEqual([tail.id]);
  const finish = DigestReadRelease.prototype.finish;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function<T>(this: DigestReadRelease, value: T) {
    await prisma.agentCredential.update({where: {id: credential.id}, data: {isActive: false}});
    return finish.call(this, value) as Promise<T>;
  });
  // A bounded query still retains the original current-caller authority through release.
  await expect(query({take: 1, objectType: "Z"})).rejects.toThrow();
}, 180_000);
