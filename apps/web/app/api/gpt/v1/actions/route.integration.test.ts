import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../../../../../../packages/shared/src/db-test-utils";
import { actionRequestSource, createAction, getAction, listActions, publishAction } from "../../../../../../../packages/domain/src/actions";
import { createConversationIngressInput } from "../../../../../../../packages/domain/src/conversation-ingress";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "../../../../../../../packages/domain/src/source-lineage";
import { POST } from "./route";

// Only the external rate counter is replaced; OAuth token/app/scope/member
// authentication, route dispatch, action lineage and ordinary readers use PG.
vi.mock("@corgtex/shared", async original => ({...await original<typeof import("@corgtex/shared")>(),
  checkRateLimit: async () => ({allowed: true, remaining: 100, resetAt: Date.now() + 60_000})}));
const db = getPrismaClient();
beforeEach(async () => {await truncateAllTables();});
async function fixture() {
  const id = randomUUID();
  const workspace = await db.workspace.create({data: {slug: `gpt-action-${id}`, name: "Synthetic GPT Action"}});
  const users = await Promise.all(["owner", "coworker"].map(name => db.user.create({data: {
    email: `${name}-${id}@example.test`, passwordHash: "synthetic", displayName: name}})));
  const members = await Promise.all(users.map(user => db.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}})));
  const app = await db.oAuthApp.create({data: {workspaceId: workspace.id, clientId: id, clientSecret: "synthetic-hash",
    name: "Synthetic GPT client", redirectUris: ["https://example.test/callback"], scopes: ["read", "write"]}});
  const token = `synthetic-${randomUUID()}`;
  const credential = await db.oAuthAccessToken.create({data: {workspaceId: workspace.id, appId: app.id, userId: users[0].id,
    tokenHash: createHash("sha256").update(token).digest("hex"), scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000)}});
  const owner: AppActor = {kind: "user", user: users[0]}, coworker: AppActor = {kind: "user", user: users[1]};
  const post = (title: string, key?: string, extra: Record<string, unknown> = {}) => POST(new NextRequest("http://localhost/api/gpt/v1/actions", {
    method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? {"Idempotency-Key": key} : {})},
    body: JSON.stringify({title, assigneeMemberId: members[0].id, ...extra}),
  }));
  return {workspace, owner, coworker, members, credential, post};
}
describe("authenticated GPT Action idempotency and original lineage", () => {
  it("creates the same readable draft with or without a key, replays once and preserves ordinary publication", async () => {
    const f = await fixture();
    const plain = await f.post("Direct unkeyed submission"); expect(plain.status).toBe(200);
    const keyed = await f.post("Direct keyed submission", "same-request", {source: {type: "MCP_REQUEST", id: "forged"}, lineageRoots: [{kind: "Document", id: "forged"}]});
    expect(keyed.status).toBe(200); const output = await keyed.json();
    expect(output).not.toHaveProperty("contentWithheld");
    expect((await (await f.post("Direct keyed submission", "same-request")).json()).id).toBe(output.id);
    expect(await db.action.count({where: {workspaceId: f.workspace.id}})).toBe(2);
    expect((await listActions(f.owner, f.workspace.id)).total).toBe(2);
    expect(await getAction(f.owner, {workspaceId: f.workspace.id, actionId: output.id})).toMatchObject({isPrivate: true, status: "DRAFT"});
    const manifests = await db.artifactInputLineage.findMany({where: {workspaceId: f.workspace.id, artifactType: "Action"}});
    expect(manifests).toHaveLength(2); expect(manifests.every(row => row.origin === "HUMAN_ORIGINAL")).toBe(true);
    await publishAction(f.owner, {workspaceId: f.workspace.id, actionId: output.id});
    expect(await getAction(f.coworker, {workspaceId: f.workspace.id, actionId: output.id})).toMatchObject({isPrivate: false, status: "OPEN"});
    const conflict = await f.post("Different payload", "same-request"); expect(conflict.status).toBe(409);
    await db.oAuthAccessToken.update({where: {id: f.credential.id}, data: {revokedAt: new Date()}});
    expect((await f.post("Direct keyed submission", "same-request")).status).toBe(401);
    expect(await db.action.count({where: {workspaceId: f.workspace.id}})).toBe(2);
  });
  it("retains readable lineage when a keyed direct request updates a confirmed duplicate", async () => {
    const f = await fixture();
    const created = await (await f.post("Exact direct duplicate", "first-request")).json();
    const updated = await createAction(f.owner, {workspaceId: f.workspace.id, title: "Exact direct duplicate", bodyMd: "Additional authenticated human detail",
      assigneeMemberId: f.members[0].id, source: actionRequestSource("GPT_REQUEST", f.owner.kind === "user" ? f.owner.user.id : "", "second-request"),
      duplicateGuard: {resolution: "update_existing", targetEntityId: created.id}});
    expect(updated.id).toBe(created.id);
    expect(await db.action.count({where: {workspaceId: f.workspace.id}})).toBe(1);
    expect(await getAction(f.owner, {workspaceId: f.workspace.id, actionId: updated.id})).toMatchObject({bodyMd: "Additional authenticated human detail"});
    expect((await db.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: updated.id}, orderBy: {revision: "desc"}})).origin).not.toBe("UNKNOWN");
  });
  it("keeps explicit private ancestry derived and withheld from coworkers after publication", async () => {
    const f = await fixture();
    const input = await createConversationIngressInput(f.owner, {workspaceId: f.workspace.id, content: "Private contributing input"});
    const roots = await captureArtifactInputProof(f.owner, f.workspace.id, [{kind: "ConversationIngressInput", id: input.id}]);
    const action = await createAction(f.owner, {workspaceId: f.workspace.id, title: "Derived private content", assigneeMemberId: f.members[0].id,
      source: actionRequestSource("GPT_REQUEST", f.owner.kind === "user" ? f.owner.user.id : "", "derived-request"), lineageRoots: roots});
    expect((await db.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: action.id}})).origin).toBe("DERIVED");
    const proof = await captureArtifactInputProof(f.owner, f.workspace.id, [{kind: "Action", id: action.id}]);
    expect(await isArtifactInputProofReadable(f.coworker, f.workspace.id, proof)).toBe(false);
    await publishAction(f.owner, {workspaceId: f.workspace.id, actionId: action.id});
    expect((await db.artifactInputLineage.findFirstOrThrow({where: {artifactType: "Action", artifactId: action.id}, orderBy: {revision: "desc"}})).origin).not.toBe("HUMAN_ORIGINAL");
    await expect(getAction(f.coworker, {workspaceId: f.workspace.id, actionId: action.id})).rejects.toMatchObject({code: "NOT_FOUND"});
  });
});
