import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { addConversationTurn, createConversation, createConversationPromptInput, getConversation, listConversations } from "./conversations";
import { captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic conversation", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const session = await createConversation(actor, { workspaceId: workspace.id, topic: "Original topic", systemPrompt: "Original system prompt" });
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic shared source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const roots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainSource", id: source.id }]);
  async function turn(message: string, extra = roots) {
    const prompt = await createConversationPromptInput(actor, { workspaceId: workspace.id, conversationId: session.id, content: message });
    return addConversationTurn(actor, { workspaceId: workspace.id, conversationId: session.id, promptInputId: prompt.id,
      userMessage: message, assistantMessage: `Answer to ${message}`, lineageRoots: extra });
  }
  const first = await turn("First question"), second = await turn("Second question");
  const hiddenSource = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic withheld source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: hiddenSource.id }, content: hiddenSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const hiddenRoots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainSource", id: hiddenSource.id }]);
  const withheld = await turn("Retained human question", hiddenRoots);
  await prisma.brainSource.update({ where: { id: hiddenSource.id }, data: { archivedAt: new Date() } });
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Synthetic circle" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Original role", accountabilities: [], artifacts: [] } });
  await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Circle", id: circle.id }, content: circle, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Role", id: role.id }, content: role, origin: "HUMAN_ORIGINAL", inputs: [] });
  });
  const onboarding = await prisma.roleOnboardingSession.create({ data: { workspaceId: workspace.id, conversationId: session.id, roleId: role.id, memberId: member.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "RoleOnboardingSession", id: onboarding.id }, content: onboarding, origin: "HUMAN_ORIGINAL", inputs: [] }));
  return { workspace, user, member, actor, session, source, first, second, withheld, role };
}

it("returns every readable detail turn and only the exact human prompt for a withheld reply", async () => {
  const f = await fixture();
  const detail = await getConversation(f.actor, f.workspace.id, f.session.id);
  expect(detail.topic).toBe("Original topic");
  expect(detail.systemPrompt).toBe("Original system prompt");
  expect(detail.roleOnboarding?.role.name).toBe("Original role");
  expect(detail.turns.map(row => row.id)).toEqual([f.first.id, f.second.id, f.withheld.id]);
  expect(detail.turns[0].assistantMessage).toBe(f.first.assistantMessage);
  expect(detail.turns[1].assistantMessage).toBe(f.second.assistantMessage);
  expect(detail.turns[2]).toMatchObject({ userMessage: f.withheld.userMessage, assistantMessage: "", contextJson: null, assistantContentWithheld: true });
  const list = await listConversations(f.actor, f.workspace.id);
  expect(list.items[0].turns).toHaveLength(1);
});

it.each(["source", "source-restore", "caller", "caller-restore", "session", "session-head", "role"] as const)(
  "withholds admitted detail after %s changes during later prompt loading", async change => {
    const f = await fixture();
    const find = prisma.conversationPromptInput.findMany.bind(prisma.conversationPromptInput);
    let changed = false;
    vi.spyOn(prisma.conversationPromptInput, "findMany").mockImplementation((async (args: Parameters<typeof find>[0]) => {
      const rows = await find(args);
      if (!changed) {
        changed = true;
        if (change.startsWith("source")) {
          await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
          if (change === "source-restore") await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
        }
        if (change.startsWith("caller")) {
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
          if (change === "caller-restore") await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
        }
        if (change === "session") await prisma.conversationSession.update({ where: { id: f.session.id }, data: { topic: "Replaced topic" } });
        if (change === "role") await prisma.role.update({ where: { id: f.role.id }, data: { name: "Replaced role" } });
        if (change === "session-head") {
          const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, artifactType: "ConversationSession", artifactId: f.session.id }, orderBy: { revision: "desc" } });
          const { id: _id, recordedAt: _recorded, ...data } = head;
          await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
            inputsJson: data.inputsJson as never, rootsJson: data.rootsJson as never, permissionEpochsJson: data.permissionEpochsJson as never } });
        }
      }
      return rows;
    }) as typeof prisma.conversationPromptInput.findMany);
    await expect(getConversation(f.actor, f.workspace.id, f.session.id)).rejects.toBeDefined();
    expect(changed).toBe(true);
  }, 60_000,
);

it("rechecks the admitted original prompt in the final shared snapshot", async () => {
  const f = await fixture();
  const client = getPrismaClient();
  const transaction = client.$transaction.bind(client);
  let changed = false;
  vi.spyOn(client, "$transaction").mockImplementation((async (
    callback: Parameters<typeof prisma.$transaction>[0], options: Parameters<typeof prisma.$transaction>[1],
  ) => {
    if (options?.isolationLevel === "RepeatableRead" && !changed) {
      changed = true;
      await prisma.conversationPromptInput.update({ where: { id: f.withheld.promptInputId! }, data: { content: "Replaced original prompt" } });
    }
    return transaction(callback, options);
  }) as typeof prisma.$transaction);
  await expect(getConversation(f.actor, f.workspace.id, f.session.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
});


it("lists an exact original prompt beyond 5100 newer denied legacy turns", async () => {
  const f = await fixture();
  await prisma.conversationTurn.createMany({ data: Array.from({ length: 5100 }, (_, index) => ({
    conversationId: f.session.id, sequenceNumber: index + 100, userMessage: "Unproved legacy input",
    assistantMessage: "Unproved legacy reply",
  })) });
  const find = vi.spyOn(prisma.conversationTurn, "findMany");
  const result = await listConversations(f.actor, f.workspace.id, { take: 1 });
  expect(result.total).toBe(1);
  expect(result.items[0].turns).toEqual([expect.objectContaining({ id: f.withheld.id,
    userMessage: f.withheld.userMessage, assistantMessage: "", assistantContentWithheld: true })]);
  expect(find).toHaveBeenCalledTimes(52);
  expect(find.mock.calls.every(([args]) => args?.take === 100 && !args.cursor)).toBe(true);
}, 120_000);
