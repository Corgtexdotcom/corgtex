import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle, updateArticle } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";

describe("Brain article derivation provenance", () => {
  beforeEach(truncateAllTables);

  it("persists verified agent lineage and preserves the human revision", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic provenance", slug: `provenance-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `provenance-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Synthetic notes", content: "Source content",
    } });
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [workspace.id] };
    const editor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Editor" } };
    const fingerprint = brainSourceContentFingerprint(source);

    const generated = await createArticle(agent, {
      workspaceId: workspace.id, title: "Generated notes", type: "PROJECT", bodyMd: "Generated body",
      sourceIds: [source.id], derivation: { sourceId: source.id, sourceFingerprint: fingerprint, agentRunId: "synthetic-run" },
    });
    const authored = await createArticle(editor, {
      workspaceId: workspace.id, title: "Authored notes", type: "PROJECT", bodyMd: "Human body", sourceIds: [source.id],
    });
    expect(generated.derivationJson).toEqual({
      version: 1, origin: "brain-absorb", agentRunId: "synthetic-run",
      sources: [{ sourceId: source.id, fingerprint }],
    });
    expect(authored.derivationJson).toBeNull();

    await updateArticle(editor, { workspaceId: workspace.id, slug: generated.slug, bodyMd: "Human revision" });
    const revised = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.id }, include: { versions: true } });
    expect(revised.bodyMd).toBe("Human revision");
    expect(revised.humanEditedAt).toBeInstanceOf(Date);
    expect(revised.versions).toMatchObject([{ bodyMd: "Generated body", agentRunId: null }]);

    await prisma.brainSource.update({ where: { id: source.id }, data: { content: "Replaced source content" } });
    await expect(createArticle(agent, {
      workspaceId: workspace.id, title: "Stale generation", type: "PROJECT", bodyMd: "Old source body",
      sourceIds: [source.id], derivation: { sourceId: source.id, sourceFingerprint: fingerprint, agentRunId: "synthetic-run" },
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.brainArticle.count({ where: { workspaceId: workspace.id } })).toBe(2);
  });
});
