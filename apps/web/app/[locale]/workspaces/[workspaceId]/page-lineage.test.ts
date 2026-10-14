import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: new Map<string, ReturnType<typeof vi.fn>>(),
  readable: vi.fn(),
}));
type Row = { id: string; workspaceId: string; title: string; allowed: boolean; [key: string]: unknown };
type Query = { take?: number; cursor?: { id: string }; where?: { id?: { in: string[] } } };
vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    ...Object.fromEntries(["brainArticle", "meeting", "action", "proposal", "tension", "workspaceBriefing", "newspaperEdition",
      "workspace", "member", "notification", "roleAssignment", "adviceRequest"].map(name => [name, {
      findMany: (query: Query) => state.queries.get(name)!(query),
      findFirst: () => null,
      findUnique: () => ({ id: "ws", slug: "synthetic", name: "Synthetic workspace" }),
      count: () => name === "member" ? 2 : 0,
    }])),
  },
  workspaceBranding: () => ({ primaryName: "Synthetic workspace" }),
  toInputJson: (value: unknown) => value,
}));
vi.mock("../../../../../../packages/domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn() }));
vi.mock("../../../../../../packages/domain/src/source-lineage", () => ({
  readableArtifactIds: state.readable, captureArtifactInputProof: vi.fn(),
  invalidateArtifactInputLineage: vi.fn(), recordArtifactInputLineage: vi.fn(),
}));
vi.mock("@corgtex/domain", async () => {
  const briefing = await import("../../../../../../packages/domain/src/workspace-briefing");
  const priority = await import("../../../../../../packages/domain/src/newspaper-priority");
  return { ...briefing, ...priority,
    normalizeNewspaperEditionDigest: vi.fn(),
    privacyFilter: () => ({}), readableArtifactIds: state.readable,
    requireWorkspaceMembership: async () => ({ id: "member", workspaceId: "ws", userId: "viewer", role: "MEMBER", isActive: true }),
  };
});
vi.mock("@corgtex/knowledge", () => ({ countReadableKnowledgeChunks: async () => 3 }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "viewer" } }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => React.createElement("a", props, children) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, args?: Record<string, unknown>) => [key, ...Object.entries(args ?? {}).map(([name, value]) => `${name}=${value}`)].join(" "),
  getFormatter: async () => ({ dateTime: () => "Synthetic date" }),
}));
vi.mock("@/lib/components/MarkdownRenderer", () => ({ MarkdownRenderer: ({ markdown, className }: { markdown: string; className?: string }) => React.createElement("div", { className }, markdown) }));
import WorkspaceDashboard from "./page";

// SSR wiring proof with a mocked permission boundary; real lineage/tenant rules
// are covered by the independent domain PG suites. Ranking/scoring stay real.
it("renders admitted tail rows and complete counts while keeping ninth-item personalization outside the eight display slots", async () => {
  const time = new Date("2026-10-01T12:00:00Z");
  const row = (id: string, title: string, allowed: boolean): Row => ({ id, title, allowed, workspaceId: "ws",
    bodyMd: `${title} content`, summaryMd: `${title} recap`, slug: id, type: "STRATEGY", isPrivate: false,
    status: "OPEN", priority: 0, assigneeMemberId: null, ownerMemberId: null, dueAt: null,
    updatedAt: time, createdAt: time, recordedAt: time });
  const hidden = (prefix: string) => Array.from({ length: 100 }, (_, index) => row(`${prefix}-${String(index).padStart(3, "0")}`, "Restricted payload", false));
  const actions = Array.from({ length: 9 }, (_, index) => ({ ...row(`a-${100 + index}`, index === 8 ? "Tail focus" : `Assigned ${index}`, true), assigneeMemberId: "member", priority: 9 - index }));
  const tables: Record<string, Row[]> = {
    action: [...hidden("a"), ...actions],
    tension: [...hidden("t"), row("t-100", "Visible tension", true)],
    proposal: [],
    brainArticle: [...hidden("b"), row("b-100", "Tail focus", true), { ...row("b-101", "Recent unrelated", true), updatedAt: new Date(time.getTime() + 1000) }],
    meeting: [...hidden("m"), row("m-100", "Visible recap", true)],
  };
  for (const name of ["brainArticle", "meeting", "action", "proposal", "tension", "workspaceBriefing", "newspaperEdition", "roleAssignment", "adviceRequest"]) {
    state.queries.set(name, vi.fn(async (query: Query) => {
      const rows = tables[name] ?? [];
      if (query.where?.id?.in) return rows.filter(value => query.where!.id!.in.includes(value.id));
      const start = query.cursor ? rows.findIndex(value => value.id === query.cursor!.id) + 1 : 0;
      return rows.slice(start, start + (query.take ?? rows.length));
    }));
  }
  state.readable.mockImplementation(async (_actor, workspaceId, _kind, rows: Row[]) => {
    expect(workspaceId).toBe("ws");
    expect(rows.every(value => value.workspaceId === "ws" && typeof value.bodyMd === "string")).toBe(true);
    return new Set(rows.filter(value => value.allowed).map(value => value.id));
  });
  // This repository compiles TSX with the classic runtime in the unit runner.
  vi.stubGlobal("React", React);
  try {
    const html = renderToStaticMarkup(await WorkspaceDashboard({ params: Promise.resolve({ workspaceId: "ws" }) }));
    expect(html).not.toContain("Restricted payload");
    expect(html).toContain("footerStats articles=2 meetings=1 chunks=3 members=2");
    expect(html).toContain("attentionTileAria label=attentionActions personal=9 total=9");
    expect(html).toContain("attentionTileAria label=attentionTensions personal=0 total=1");
    expect(html.match(/<li>/g)).toHaveLength(8);
    expect(html).not.toContain('href="/workspaces/ws/actions/a-108"');
    expect(html).toContain('<div class="nr-newspaper-lead">**Tail focus**');
    expect(html).toContain("Visible recap");
    const prefixes: Record<string, string> = { brainArticle: "b", meeting: "m", action: "a", tension: "t" };
    for (const name of Object.keys(prefixes)) {
      expect(state.queries.get(name)).toHaveBeenCalledTimes(2);
      expect(state.queries.get(name)!.mock.calls[1][0]).toMatchObject({ take: 100, cursor: { id: `${prefixes[name]}-099` } });
    }
  } finally { vi.unstubAllGlobals(); }
});
