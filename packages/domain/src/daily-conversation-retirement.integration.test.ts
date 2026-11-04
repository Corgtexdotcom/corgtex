import { beforeEach, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput, addConversationTurn } from "./conversations";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "./source-lineage";
import { captureReadableDigestInputs } from "./digest-lineage";

beforeEach(truncateAllTables);

it("withholds private prompts and proved turns from generic daily agents before model derivation", async () => {
  const workspace = await prisma.workspace.create({ data: { slug: "daily-private", name: "Synthetic daily privacy" } });
  const user = await prisma.user.create({ data: { email: "daily-private@example.test", passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const owner: AppActor = { kind: "user", user };
  const session = await createConversation(owner, { workspaceId: workspace.id });
  const prompt = await createConversationPromptInput(owner, { workspaceId: workspace.id, conversationId: session.id, content: "PRIVATE_PROMPT_CANARY" });
  const roots = await captureArtifactInputProof(owner, workspace.id, [{ kind: "ConversationPromptInput", id: prompt.id }]);
  const turn = await addConversationTurn(owner, { workspaceId: workspace.id, conversationId: session.id,
    promptInputId: prompt.id, userMessage: prompt.content, assistantMessage: "PRIVATE_ANSWER_CANARY", lineageRoots: roots });
  const turnRoots = await captureArtifactInputProof(owner, workspace.id, [{ kind: "ConversationTurn", id: turn.id }]);
  expect(await isArtifactInputProofReadable(owner, workspace.id, turnRoots)).toBe(true);
  const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "daily-digest", workspaceIds: [workspace.id] };
  expect(await isArtifactInputProofReadable(agent, workspace.id, roots)).toBe(false);
  expect(await isArtifactInputProofReadable(agent, workspace.id, turnRoots)).toBe(false);
  expect(await captureReadableDigestInputs({ actor: agent, workspaceId: workspace.id, kind: "ConversationTurn", records: [turn] }))
    .toMatchObject({ records: [], roots: [] });
  expect(await prisma.brainSource.count({ where: { workspaceId: workspace.id } })).toBe(0);
}, 120_000);
