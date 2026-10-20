import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {prisma, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../packages/shared/src/db-test-utils";
import {recordArtifactInputLineage} from "../../packages/domain/src/source-lineage";
const state = vi.hoisted(() => ({actor: null as AppActor | null}));
vi.mock("@corgtex/domain", async () => ({...await import("../../packages/domain/src/constitutions"), ...await import("../../packages/domain/src/digest-lineage"),
  listPolicyCorpus: async () => [], getApprovalPolicies: async () => [], getLatestGovernanceScore: async () => null,
  listGovernanceScores: async () => [], getCurrentConstitution: async () => null}));
vi.mock("@/lib/auth", () => ({requirePageActor: async () => state.actor}));
vi.mock("@/lib/workspace-feature-flags", () => ({requireWorkspaceFeature: async () => {}}));
vi.mock("next-intl/server", () => ({getTranslations: async () => (key: string) => key}));
vi.mock("./app/[locale]/workspaces/[workspaceId]/actions", () => ({updateApprovalPolicyAction: () => {}, recalculateGovernanceScoreAction: () => {}, triggerAgentRunAction: () => {}}));
vi.mock("@/lib/components/MarkdownRenderer", () => ({MarkdownRenderer: ({markdown}: {markdown: string}) => React.createElement("div", null, markdown), MarkdownExcerpt: ({markdown}: {markdown: string}) => React.createElement("div", null, markdown)}));
import GovernancePage from "./app/[locale]/workspaces/[workspaceId]/governance/page";
beforeEach(async () => {vi.stubGlobal("React", React); await truncateAllTables();});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
it.each(["positive", "head", "caller-restore"] as const)("retains original Governance history through final workspace await: %s", async mode => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic governance release", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user}; state.actor = actor;
  const row = await prisma.constitution.create({data: {workspaceId: workspace.id, version: 1, bodyMd: "Original constitution", diffSummary: "ORIGINAL HISTORY SUMMARY", modelUsed: "synthetic"}});
  const mint = () => prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind: "Constitution", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  await mint();
  let changed = false; const original = prisma.workspace.findUnique.bind(prisma.workspace);
  vi.spyOn(prisma.workspace, "findUnique").mockImplementation((async args => {
    const result = await original(args);
    if (!changed && args?.select?.slug) {
      if (mode === "head") await mint();
      if (mode === "caller-restore") {
        await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
      }
      changed = true;
    }
    return result;
  }) as typeof prisma.workspace.findUnique);
  const page = GovernancePage({params: Promise.resolve({workspaceId: workspace.id})});
  if (mode === "positive") expect(renderToStaticMarkup(await page)).toContain(row.diffSummary);
  else await expect(page).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  if (mode === "head") expect(await prisma.artifactInputLineage.count({where: {workspaceId: workspace.id, artifactType: "Constitution", artifactId: row.id}})).toBe(2);
});
