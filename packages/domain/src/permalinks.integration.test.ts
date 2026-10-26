import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {prisma, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../shared/src/db-test-utils";
import {recordArtifactInputLineage} from "./source-lineage";
import {resolveWorkspacePermalink, WORKSPACE_PERMALINK_ENTITY_TYPES, type WorkspacePermalinkEntityType} from "./permalinks";
import {configureInformationCategory} from "./information-category-policy";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(kind: WorkspacePermalinkEntityType) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic permalink", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const source = await prisma.brainSource.create({data: {workspaceId: workspace.id, sourceType: "RFC", tier: 1, content: "Authenticated synthetic original"}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind: "BrainSource", id: source.id}, content: source, origin: "HUMAN_ORIGINAL", inputs: []}));
  const common = {workspaceId: workspace.id, title: "Synthetic target"};
  const target = kind === "Action" ? await prisma.action.create({data: {...common, authorUserId: user.id, bodyMd: "Original"}})
    : kind === "Tension" ? await prisma.tension.create({data: {...common, authorUserId: user.id, bodyMd: "Original"}})
    : kind === "Proposal" ? await prisma.proposal.create({data: {...common, authorUserId: user.id, bodyMd: "Original"}})
    : kind === "BrainArticle" ? await prisma.brainArticle.create({data: {...common, slug: "original", type: "PROCESS", bodyMd: "Original", sourceIds: []}})
    : kind === "Meeting" ? await prisma.meeting.create({data: {...common, source: "manual", recordedAt: new Date(), transcript: "Original"}})
    : await prisma.goal.create({data: {...common, authorUserId: user.id, descriptionMd: "Original"}});
  const prove = () => prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind, id: target.id}, content: target, origin: "DERIVED", inputs: [{kind: "BrainSource", id: source.id}]}));
  await prove();
  const permalink = await prisma.workspacePermalink.create({data: {workspaceId: workspace.id, entityType: kind,
    entityId: target.id, canonicalPath: "/untrusted-saved-path"}});
  return {actor, member, workspaceId: workspace.id, source, target, prove, params: {workspaceId: workspace.id, permalinkId: permalink.id}};
}

it.each(WORKSPACE_PERMALINK_ENTITY_TYPES)("serves a proved %s but denies its revoked parent and foreign workspace", async kind => {
  const f = await fixture(kind);
  const result = await resolveWorkspacePermalink(f.actor, f.params);
  expect(result.status).toBe("ACTIVE");
  expect(result.canonicalPath).toContain(`/workspaces/${f.workspaceId}/`);
  expect(result.canonicalPath).not.toBe("/untrusted-saved-path");
  const foreign = await prisma.workspace.create({data: {name: "Foreign", slug: randomUUID()}});
  await prisma.member.create({data: {workspaceId: foreign.id, userId: f.actor.kind === "user" ? f.actor.user.id : "", role: "ADMIN"}});
  await expect(resolveWorkspacePermalink(f.actor, {...f.params, workspaceId: foreign.id})).rejects.toMatchObject({code: "NOT_FOUND"});
  await prisma.brainSource.update({where: {id: f.source.id}, data: {archivedAt: new Date()}});
  await expect(resolveWorkspacePermalink(f.actor, f.params)).rejects.toMatchObject({code: "NOT_FOUND"});
});

it.each(["head", "caller"])("rejects original proof or caller changes during the later archive lookup: %s", async change => {
  const f = await fixture("Action");
  const original = prisma.workspaceArchiveRecord.findFirst.bind(prisma.workspaceArchiveRecord);
  vi.spyOn(prisma.workspaceArchiveRecord, "findFirst").mockImplementationOnce((async args => {
    const row = await original(args);
    if (change === "head") await f.prove();
    else await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
    return row;
  }) as typeof prisma.workspaceArchiveRecord.findFirst);
  await expect(resolveWorkspacePermalink(f.actor, f.params)).rejects.toThrow();
});

it("withholds a category-restricted Meeting and archived target instead of exposing saved status metadata", async () => {
  const f = await fixture("Meeting");
  const other = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: f.workspaceId, userId: other.id, role: "CONTRIBUTOR"}});
  const viewer: AppActor = {kind: "user", user: other};
  await configureInformationCategory(f.actor, {workspaceId: f.workspaceId, category: "GENERAL", isRestricted: true, allowedRoleIds: [], allowedCircleIds: []});
  await expect(resolveWorkspacePermalink(viewer, f.params)).rejects.toMatchObject({code: "NOT_FOUND"});
  await prisma.meeting.update({where: {id: f.target.id}, data: {archivedAt: new Date()}});
  await expect(resolveWorkspacePermalink(f.actor, f.params)).rejects.toMatchObject({code: "NOT_FOUND"});
});
