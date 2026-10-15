import React from "react";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { recordArtifactInputLineage, lineageContentFingerprint } from "../../../../../../packages/domain/src/source-lineage";
const hooks = vi.hoisted(() => ({ actor: null as unknown, afterFamilies: async () => {} }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => hooks.actor }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ dateTime: () => "synthetic" }),
}));
vi.mock("@corgtex/knowledge", () => ({ countReadableKnowledgeChunkAggregate: async () => { await hooks.afterFamilies(); return 0; } }));
vi.mock("@corgtex/domain", async importOriginal => ({ ...await importOriginal<typeof import("@corgtex/domain")>(), countUnreadNotifications: async () => 0 }));
import WorkspaceDashboard from "./page";
vi.stubGlobal("React", React);
const workspaces: string[] = [];
const users: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  hooks.afterFamilies = async () => {};
  for (const id of workspaces.splice(0)) await db.workspace.delete({ where: { id } });
  for (const id of users.splice(0)) await db.user.delete({ where: { id } });
});
it.each(["withdrawal", "epoch ABA", "head", "unchanged"] as const)("dashboard rejects early article observations after later families complete: %s", async change => {
  const workspace = await db.workspace.create({ data: { name: "Synthetic dashboard", slug: randomUUID() } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@dashboard.test`, passwordHash: "synthetic" } });
  workspaces.push(workspace.id); users.push(user.id);
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  hooks.actor = actor;
  const article = await db.brainArticle.create({ data: { workspaceId: workspace.id, slug: "original", title: "Early article canary", bodyMd: "Original body", type: "PROCESS" } });
  await db.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] }));
  hooks.afterFamilies = async () => {
    if (change === "unchanged") return;
    if (change === "head") {
      const head = await db.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: workspace.id, artifactType: "BrainArticle", artifactId: article.id }, orderBy: { revision: "desc" } });
      await db.artifactInputLineage.create({ data: { workspaceId: workspace.id, artifactType: "BrainArticle", artifactId: article.id,
        revision: head.revision + 1, origin: "HUMAN_ORIGINAL", contentHash: lineageContentFingerprint("BrainArticle", article), inputsJson: [], rootsJson: [] } });
    } else {
      await db.member.update({ where: { id: member.id }, data: { isActive: false } });
      if (change === "epoch ABA") await db.member.update({ where: { id: member.id }, data: { isActive: true } });
    }
  };
  const result = WorkspaceDashboard({ params: Promise.resolve({ workspaceId: workspace.id }) });
  if (change === "unchanged") expect(JSON.stringify(await result, (key, value) => key === "type" || key === "_owner" ? undefined : value)).toContain("Early article canary");
  else await expect(result).rejects.toMatchObject({ code: change === "withdrawal" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
});
