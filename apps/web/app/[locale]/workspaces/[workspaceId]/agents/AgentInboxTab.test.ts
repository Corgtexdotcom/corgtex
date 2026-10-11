import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInboxTab } from "./AgentInboxTab";

const { getProposalMock } = vi.hoisted(() => ({ getProposalMock: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ getProposal: getProposalMock }));
vi.mock("./actions", () => ({ submitAgentFeedbackAction: vi.fn() }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href: `/${locale}${href}` }, children),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => {
    const messages = JSON.parse(readFileSync(path.resolve(process.cwd(), `apps/web/messages/${locale}.json`), "utf8")).agents;
    return (key: string, values?: Record<string, string>) =>
      String(messages[key]).replace(/\{(\w+)\}/g, (_: string, name: string) => values?.[name] ?? "");
  },
}));

let locale = "en";
type PendingRun = Parameters<typeof AgentInboxTab>[0]["pendingRuns"][number];
const actor = { userId: "synthetic-user" } as unknown as Parameters<typeof AgentInboxTab>[0]["actor"];
const workspaceId = "synthetic-workspace";
const proposalId = "synthetic-proposal";
const secret = "SYNTHETIC_PRIVATE_TRACE";

function run(overrides: Record<string, unknown> = {}): PendingRun {
  return {
    id: "synthetic-run",
    agentKey: "constitution-update-trigger",
    goal: "Review the approved proposal",
    createdAt: new Date("2026-01-01T12:00:00Z"),
    startedAt: null,
    steps: [{ id: "synthetic-step", outputJson: { context: secret } }],
    contextJson: { trace: secret },
    resultJson: {
      proposalId,
      impactSummary: "Policy follow-up suggested.",
      approvalCheckpoint: {
        summary: "Review the proposed policy follow-up.",
        detail: { proposalId, impactSummary: "Policy follow-up suggested.", hidden: secret },
      },
    },
    ...overrides,
  } as unknown as PendingRun;
}

async function htmlFor(item: PendingRun) {
  return renderToStaticMarkup(await AgentInboxTab({ workspaceId, actor, pendingRuns: [item] }));
}

describe("AgentInboxTab", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    locale = "en";
    getProposalMock.mockReset();
    getProposalMock.mockResolvedValue({ id: proposalId, title: "Synthetic approved proposal" });
  });

  it("shows authorized constitution review context without offering a reply to a missing question", async () => {
    const html = await htmlFor(run());
    expect(getProposalMock).toHaveBeenCalledWith(actor, { workspaceId, proposalId });
    expect(html).toContain("/workspaces/synthetic-workspace/proposals/synthetic-proposal");
    expect(html).toContain("Synthetic approved proposal");
    expect(html).toContain("Review the proposed policy follow-up.");
    expect(html).toContain("Policy follow-up suggested.");
    expect(html).toContain("missing the context needed for a safe reply");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Waiting for input");
    expect(html).not.toContain(secret);
  });

  it.each(["missing", "foreign", "archived", "denied", "unavailable"])(
    "hides source details and reply when the proposal is %s",
    async () => {
      getProposalMock.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_TRACE"));
      const html = await htmlFor(run({ steps: [{ id: "synthetic-step", outputJson: { question: "Private question" } }] }));
      expect(html).toContain("missing the context needed for a safe reply");
      expect(html).not.toContain("Policy follow-up suggested.");
      expect(html).not.toContain("Private question");
      expect(html).not.toContain("Synthetic approved proposal");
      expect(html).not.toContain("Review the approved proposal");
      expect(html).not.toContain(secret);
      expect(html).not.toContain("<form");
    },
  );

  it("rejects malformed or mismatched constitution checkpoints before the proposal read", async () => {
    for (const resultJson of [null, {}, { proposalId: "different", approvalCheckpoint: { detail: { proposalId } } }]) {
      getProposalMock.mockClear();
      const html = await htmlFor(run({ resultJson }));
      expect(getProposalMock).not.toHaveBeenCalled();
      expect(html).toContain("missing the context needed for a safe reply");
      expect(html).not.toContain("<form");
    }
  });

  it("preserves the existing reply form for an explicit question with a visible proposal", async () => {
    const html = await htmlFor(run({ steps: [{ id: "synthetic-step", outputJson: { question: "Which policy change should be reviewed?" } }] }));
    expect(html).toContain("Which policy change should be reviewed?");
    expect(html).toContain("Reply to the agent");
    expect(html).toContain('name="stepId" value="synthetic-step"');
    expect(html).toContain("<form");
    expect(html).not.toContain(secret);
  });

  it("keeps a valid non-constitution question but suppresses its missing-question form", async () => {
    const valid = await htmlFor(run({ agentKey: "proposal-drafting", steps: [{ id: "synthetic-step", outputJson: { question: "What should the draft say?" } }] }));
    const missing = await htmlFor(run({ agentKey: "proposal-drafting" }));
    expect(valid).toContain("What should the draft say?");
    expect(valid).toContain("<form");
    expect(missing).toContain("missing the context needed for a safe reply");
    expect(missing).not.toContain("<form");
    expect(getProposalMock).not.toHaveBeenCalled();
  });

  it("renders localized context and a labeled reply in Spanish", async () => {
    locale = "es";
    const html = await htmlFor(run({ steps: [{ id: "synthetic-step", outputJson: { question: "¿Qué decisión?" } }] }));
    expect(html).toContain("Contexto de revisión");
    expect(html).toContain("Propuesta: Synthetic approved proposal");
    expect(html).toContain('href="/es/workspaces/synthetic-workspace/proposals/synthetic-proposal"');
    expect(html).toContain("Responder al agente");
  });
});
