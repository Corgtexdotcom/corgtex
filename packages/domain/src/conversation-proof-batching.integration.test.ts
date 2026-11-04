import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { addConversationTurn, createConversation, createConversationPromptInput, getConversation } from "./conversations";
import { captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import * as lineage from "./source-lineage";

beforeAll(async () => { await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"); });
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(count: number) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic conversation batching", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const session = await createConversation(actor, { workspaceId: workspace.id, topic: "Complete private history" });
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic original source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const roots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainSource", id: source.id }]);
  const turns = [];
  for (let index = 0; index < count; index++) {
    const content = `Question ${index}`;
    const prompt = await createConversationPromptInput(actor, { workspaceId: workspace.id, conversationId: session.id, content });
    turns.push(await addConversationTurn(actor, { workspaceId: workspace.id, conversationId: session.id, promptInputId: prompt.id,
      userMessage: content, assistantMessage: `Answer ${index}`, lineageRoots: roots }));
  }
  return { workspace, user, member, actor, session, source, turns };
}

async function queryCalls() {
  const rows = await prisma.$queryRaw<Array<{ calls: bigint }>>`SELECT COALESCE(sum(calls), 0)::bigint AS calls FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return Number(rows[0].calls);
}

it.each([200, 1000])("releases all %i turns with bounded admission and final-replay SQL", async (count) => {
  const f = await fixture(count);
  const before = await queryCalls(), started = Date.now();
  const result = await getConversation(f.actor, f.workspace.id, f.session.id);
  const calls = await queryCalls() - before;
  process.stdout.write("CONVERSATION_QUERY_RECEIPT " + JSON.stringify({ turns: count, sqlCalls: calls, durationMs: Date.now() - started }) + "\n");
  expect(result.turns.map(row => row.id)).toEqual(f.turns.map(row => row.id));
  expect(result.turns.every((row, index) => row.assistantMessage === `Answer ${index}` && !row.assistantContentWithheld)).toBe(true);
  expect(calls).toBeLessThan(count * 10);
}, 300_000);


it("keeps readable siblings and exact prompt redaction beside unknown or stale-derived turns", async () => {
  const f = await fixture(3);
  await prisma.artifactInputLineage.deleteMany({ where: { workspaceId: f.workspace.id, artifactType: "ConversationTurn", artifactId: f.turns[1].id } });
  await prisma.conversationTurn.update({ where: { id: f.turns[2].id }, data: { assistantMessage: "Uncertified replacement" } });
  const result = await getConversation(f.actor, f.workspace.id, f.session.id);
  expect(result.turns).toHaveLength(3);
  expect(result.turns[0]).toMatchObject({ assistantMessage: "Answer 0", assistantContentWithheld: false });
  expect(result.turns.slice(1)).toEqual([
    expect.objectContaining({ userMessage: "Question 1", assistantMessage: "", assistantContentWithheld: true }),
    expect.objectContaining({ userMessage: "Question 2", assistantMessage: "", assistantContentWithheld: true }),
  ]);
});

it("preserves ordinary immutable-source fallback without admitting another user's prompt or tenant", async () => {
  const f = await fixture(1);
  const turn = f.turns[0];
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
    artifact: { kind: "ConversationTurn", id: turn.id }, content: turn, origin: "DERIVED",
    inputs: [{ kind: "BrainSource", id: f.source.id }, { kind: "ConversationPromptInput", id: turn.promptInputId! }],
    transitiveOnlyKinds: ["BrainSource"] }));
  const capture = vi.spyOn(lineage, "captureReadableConversationInputs");
  const detail = await getConversation(f.actor, f.workspace.id, f.session.id);
  expect(detail.turns[0]).toMatchObject({ assistantMessage: "Answer 0", assistantContentWithheld: false });
  expect((await Promise.all(capture.mock.results.map(result => result.value))).some(result => result === null)).toBe(true);
  const stranger = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: stranger.id } });
  await expect(getConversation({ kind: "user", user: stranger }, f.workspace.id, f.session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic other tenant", slug: randomUUID() } });
  expect(await lineage.captureReadableConversationInputs(f.actor, foreign.id, "ConversationTurn", [turn])).toBeNull();
  await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
  expect((await getConversation(f.actor, f.workspace.id, f.session.id)).turns[0]).toMatchObject({ assistantMessage: "", assistantContentWithheld: true });
});

it.each(["turn", "prompt", "source"] as const)("retains the original %s head through later prompt loading", async kind => {
  const f = await fixture(2);
  const capture = lineage.captureReadableConversationInputs;
  let admittedTurns = false, changed = false;
  vi.spyOn(lineage, "captureReadableConversationInputs").mockImplementation(async (...args) => {
    const result = await capture(...args);
    if (args[2] === "ConversationTurn" && result?.records.length) admittedTurns = true;
    return result;
  });
  const find = prisma.conversationPromptInput.findMany.bind(prisma.conversationPromptInput);
  vi.spyOn(prisma.conversationPromptInput, "findMany").mockImplementation((async (args: Parameters<typeof find>[0]) => {
    const rows = await find(args);
    if (admittedTurns && !changed) {
      const identity = kind === "turn" ? { artifactType: "ConversationTurn", artifactId: f.turns[0].id }
        : kind === "source" ? { artifactType: "BrainSource", artifactId: f.source.id }
        : { artifactType: "ConversationPromptInput", artifactId: f.turns[0].promptInputId! };
      if (kind === "prompt") {
        const prompt = await prisma.conversationPromptInput.findUniqueOrThrow({ where: { id: identity.artifactId } });
        await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: { kind: "ConversationPromptInput", id: prompt.id }, content: prompt, origin: "HUMAN_ORIGINAL", inputs: [] }));
      } else {
        const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, ...identity }, orderBy: { revision: "desc" } });
        const { id: _id, recordedAt: _recorded, ...data } = head;
        await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
          inputsJson: data.inputsJson as never, rootsJson: data.rootsJson as never, permissionEpochsJson: data.permissionEpochsJson as never } });
      }
      changed = true;
    }
    return rows;
  }) as typeof prisma.conversationPromptInput.findMany);
  await expect(getConversation(f.actor, f.workspace.id, f.session.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
});
