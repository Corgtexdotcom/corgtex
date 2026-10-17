import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi, type Mock } from "vitest";

const state = vi.hoisted(() => ({
  realTranslations: false,
  chunkSummary: {count: 3, complete: true},
  queries: new Map<string, Mock<(query: Query) => Promise<Row[]>>>(),
  readable: vi.fn(),
  unread: vi.fn<(actor: unknown, workspaceId: string) => Promise<number>>(async () => 0),
  edition: vi.fn(),
  release: vi.fn(),
}));
type Row = { id: string; workspaceId: string; title: string; allowed: boolean; [key: string]: unknown };
type Query = { take?: number; cursor?: { id: string }; where?: { id?: { in: string[] }; OR?: Array<{generatedAt?: Date | {lt: Date}; id?: {lt: string}}> }; orderBy?: unknown };
vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    ...Object.fromEntries(["brainArticle", "meeting", "action", "proposal", "tension", "workspaceBriefing", "newspaperEdition",
      "workspace", "member", "notification", "roleAssignment", "adviceRequest"].map(name => [name, {
      findMany: (query: Query) => state.queries.get(name)!(query),
      findFirst: () => null,
      findUnique: () => ({ id: "ws", slug: "synthetic", name: "Synthetic workspace" }),
      count: () => { if (name === "notification") throw new Error("Raw notification counts are not authorized"); return name === "member" ? 2 : 0; },
    }])),
  },
  workspaceBranding: () => ({ primaryName: "Synthetic workspace" }),
  toInputJson: (value: unknown) => value,
}));
vi.mock("../../../../../../packages/domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn() }));
vi.mock("../../../../../../packages/domain/src/source-lineage", () => ({
  readableArtifactIds: state.readable,
  captureArtifactInputProof: async (actor: unknown, workspaceId: string, inputs: Array<{kind: string; id: string; snapshot: {id: string}}>) => {
    for (const input of inputs) if (!(await state.readable(actor, workspaceId, input.kind, [input.snapshot])).has(input.id)) {
      const {AppError} = await import("../../../../../../packages/domain/src/errors");
      throw new AppError(409, "SOURCE_RESTRICTED", "Synthetic denied input");
    }
    return inputs.map(input => ({kind: input.kind, id: input.id, fingerprint: JSON.stringify(input.snapshot)}));
  },
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  mergeLineageInputRoot: (_prior: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: (...args: unknown[]) => state.release(...args),
  invalidateArtifactInputLineage: vi.fn(), recordArtifactInputLineage: vi.fn(),
}));
vi.mock("@corgtex/domain", async () => {
  const briefing = await import("../../../../../../packages/domain/src/workspace-briefing");
  const priority = await import("../../../../../../packages/domain/src/newspaper-priority");
  return { ...briefing, ...priority,
    ...await import("../../../../../../packages/domain/src/digest-lineage"),
    ...await import("../../../../../../packages/domain/src/errors"),
    normalizeNewspaperEditionDigest: state.edition,
    getUnreadNotificationSummary: async (actor: unknown, workspaceId: string) => ({ count: await state.unread(actor, workspaceId), complete: true, available: true }),
    privacyFilter: () => ({}), readableArtifactIds: state.readable,
    requireWorkspaceMembership: async () => ({ id: "member", workspaceId: "ws", userId: "viewer", role: "MEMBER", isActive: true }),
  };
});
vi.mock("@corgtex/knowledge", () => ({ getReadableKnowledgeChunkSummary: async () => state.chunkSummary }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "viewer" } }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => React.createElement("a", props, children) }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => {
    if (state.realTranslations) {
      const { readFile } = await import("node:fs/promises");
      const { createTranslator } = await import("next-intl");
      return createTranslator({ locale: "en", messages: JSON.parse(await readFile("apps/web/messages/en.json", "utf8")).dashboard });
    }
    return (key: string, args?: Record<string, unknown>) => [key, ...Object.entries(args ?? {}).map(([name, value]) => `${name}=${value}`)].join(" ");
  },
  getFormatter: async () => ({ dateTime: () => "Synthetic date" }),
}));
vi.mock("@/lib/components/MarkdownRenderer", () => ({ MarkdownRenderer: ({ markdown, className }: { markdown: string; className?: string }) => React.createElement("div", { className }, markdown) }));
import WorkspaceDashboard from "./page";

const time = new Date("2026-10-01T12:00:00Z");
const row = (id: string, title: string, allowed: boolean): Row => ({ id, title, allowed, workspaceId: "ws",
  bodyMd: `${title} content`, summaryMd: `${title} recap`, slug: id, type: "STRATEGY", isPrivate: false,
  status: "OPEN", priority: 0, assigneeMemberId: null, ownerMemberId: null, dueAt: null,
  updatedAt: time, createdAt: time, recordedAt: time, generatedAt: time });
function installRows(tables: Record<string, Row[]>) {
  for (const name of ["brainArticle", "document", "meeting", "action", "proposal", "tension", "goal", "recognition", "workspaceBriefing", "newspaperEdition", "roleAssignment", "adviceRequest"]) {
    state.queries.set(name, vi.fn(async (query: Query) => {
      let rows = tables[name] ?? [];
      if (query.where?.id?.in) return rows.filter(value => query.where!.id!.in.includes(value.id));
      const boundary = query.where?.OR?.find(value => value.id?.lt);
      if (boundary?.generatedAt instanceof Date) {
        const generatedAt = boundary.generatedAt;
        rows = rows.filter(value => (value.generatedAt as Date) < generatedAt
          || ((value.generatedAt as Date).getTime() === generatedAt.getTime() && value.id < boundary.id!.lt));
      }
      const start = query.cursor ? rows.findIndex(value => value.id === query.cursor!.id) + 1 : 0;
      return rows.slice(start, start + (query.take ?? rows.length));
    }));
  }
}
beforeEach(() => {
  state.release.mockImplementation(async (_actor, _workspaceId, _roots, remote, finish) => {await remote(); return finish({});});
  state.chunkSummary = {count: 3, complete: true};
  vi.clearAllMocks(); state.unread.mockResolvedValue(0); state.edition.mockReturnValue(null);
  installRows({});
  state.readable.mockImplementation(async (_actor, workspaceId, _kind, rows: Row[]) => {
    expect(workspaceId).toBe("ws");
    expect(rows.every(value => value.workspaceId === "ws" && typeof value.bodyMd === "string")).toBe(true);
    return new Set(rows.filter(value => value.allowed).map(value => value.id));
  });
});
async function renderDashboard() {
  vi.stubGlobal("React", React);
  try { return renderToStaticMarkup(await WorkspaceDashboard({ params: Promise.resolve({ workspaceId: "ws" }) })); }
  finally { vi.unstubAllGlobals(); }
}

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

it("replenishes latest briefing and newspaper past a denied page using deterministic bounded canonical reads", async () => {
  const hidden = Array.from({length: 100}, (_, index) => row(`z-${String(100 - index).padStart(3, "0")}`, "Restricted payload", false));
  const briefing = {...row("b-allowed", "Permitted briefing", true), briefingJson: {title: "Permitted briefing", leadMd: "Readable older briefing", items: []}};
  const edition = row("e-allowed", "Permitted newspaper", true);
  installRows({ workspaceBriefing: [...hidden, briefing], newspaperEdition: [...hidden, edition] });
  state.unread.mockResolvedValue(7);
  const html = await renderDashboard();
  expect(html).toContain("Permitted briefing");
  expect(html).toContain("unreadNotificationsSummary count=7");
  expect(html).not.toContain("Restricted payload");
  expect(state.edition).toHaveBeenCalledWith(edition);
  expect(state.unread).toHaveBeenCalledWith(expect.objectContaining({kind: "user"}), "ws");
  for (const name of ["workspaceBriefing", "newspaperEdition"]) {
    expect(state.queries.get(name)).toHaveBeenCalledTimes(2);
    expect(state.queries.get(name)!.mock.calls[0][0]).toMatchObject({take: 100, orderBy: [{generatedAt: "desc"}, {id: "desc"}], where: {workspaceId: "ws"}});
    expect(state.queries.get(name)!.mock.calls[0][0]).not.toHaveProperty("select");
    expect(state.queries.get(name)!.mock.calls[1][0]).toMatchObject({where: {OR: [{generatedAt: {lt: time}}, {generatedAt: time, id: {lt: "z-001"}}]}});
  }
});

it("terminates denied-only edition scans without revealing their content", async () => {
  installRows({workspaceBriefing: [row("hidden", "Restricted payload", false)], newspaperEdition: [row("hidden", "Restricted payload", false)]});
  const html = await renderDashboard();
  expect(html).not.toContain("Restricted payload");
  expect(state.edition).not.toHaveBeenCalled();
  expect(state.queries.get("workspaceBriefing")).toHaveBeenCalledTimes(1);
  expect(state.queries.get("newspaperEdition")).toHaveBeenCalledTimes(1);
});

it("uses only readable advice to create personal signals and deadlines, replenishing beyond denied requests", async () => {
  const request = (id: string, allowed: boolean, subjectId: string): Row => ({...row(id, "Advice", allowed),
    deadlineAt: time, process: {subjectType: "ACTION", subjectId}, audienceType: "WORKSPACE"});
  const denied = Array.from({length: 100}, (_, index) => request(`r-${String(index).padStart(3, "0")}`, false, "a-hidden-advice"));
  installRows({adviceRequest: [...denied, request("r-100", true, "a-visible-advice")], action: [
    row("a-hidden-advice", "No personal signal", true), row("a-visible-advice", "Permitted advice action", true),
  ]});
  const html = await renderDashboard();
  expect(html).toContain("attentionTileAria label=attentionActions personal=1 total=2");
  expect(html).toContain("Permitted advice action");
  expect(html).not.toContain("No personal signal");
  expect(html.match(/personalReasonAdvice/g)).toHaveLength(1);
  expect(state.queries.get("adviceRequest")).toHaveBeenCalledTimes(2);
  expect(state.queries.get("adviceRequest")!.mock.calls[0][0]).toMatchObject({take: 100, where: {workspaceId: "ws", status: "ACTIVE"}, include: {process: {select: {subjectType: true, subjectId: true}}}});
  expect(state.queries.get("adviceRequest")!.mock.calls[0][0]).not.toHaveProperty("select");
});

it("withholds the response when the final original-proof release rejects", async () => {
  state.release.mockRejectedValueOnce(new Error("Synthetic final release denied"));
  await expect(renderDashboard()).rejects.toThrow("Synthetic final release denied");
});

it("bounds large hidden families and renders qualified counts and empty snapshots", async () => {
  const hidden = (prefix: string) => Array.from({length: 201}, (_, i) => row(`${prefix}-${String(i).padStart(3, "0")}`, "Restricted payload", false));
  installRows({ action: hidden("a"), adviceRequest: hidden("r"), brainArticle: hidden("b"), meeting: hidden("m"),
    workspaceBriefing: hidden("z").reverse(), newspaperEdition: hidden("y").reverse() });
  const html = await renderDashboard();
  expect(html).toContain("limitedSnapshot");
  expect(html).toContain("snapshotEmpty");
  expect(html).not.toContain("personalNewspaperEmpty");
  expect(html).not.toContain("newspaperEmptyBody");
  expect(html).not.toContain("Restricted payload");
  expect(html).toContain("personal=… total=…");
  expect(html).toContain("articles=… meetings=…");
  for (const family of ["action", "adviceRequest", "brainArticle", "meeting", "workspaceBriefing", "newspaperEdition"]) {
    expect(state.queries.get(family)).toHaveBeenCalledTimes(2);
  }
});

it("qualifies personal counts when only the advice window is incomplete", async () => {
  installRows({ adviceRequest: Array.from({length: 200}, (_, i) => ({...row(`r-${String(i).padStart(3, "0")}`, "Restricted", false), process: {subjectType: "ACTION", subjectId: "a"}})),
    action: [{...row("a", "Assigned", true), assigneeMemberId: "member"}] });
  const html = await renderDashboard();
  expect(html).toContain("personal=1+ total=1");
  expect(html).toContain("limitedSnapshot");
});

it("qualifies an incomplete knowledge-only count without claiming an empty knowledge base", async () => {
  state.chunkSummary = {count: 0, complete: false};
  const html = await renderDashboard();
  expect(html).toContain("limitedSnapshot");
  expect(html).toContain("chunks=…");
  expect(html).not.toContain("chunks=0");
});

it.runIf(process.env.DASHBOARD_WINDOW_BROWSER_QA === "1")("shows the limited snapshot and usable full-list link in a running browser", async () => {
  const { createServer } = await import("node:http");
  const { mkdir, readFile } = await import("node:fs/promises");
  const { chromium } = await import("playwright");
  installRows({ action: Array.from({length: 201}, (_, i) => ({...row(`a-${String(i).padStart(3, "0")}`, "Visible assigned action", true), assigneeMemberId: "member"})) });
  state.realTranslations = true;
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"].map(path => readFile(`apps/web/app/${path}`, "utf8")))).join("\n");
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.includes("/actions")) { response.end("<h1>Action section fixture</h1>"); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body>${await renderDashboard()}</body></html>`);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/workspaces/ws`);
    await page.getByRole("status").filter({hasText: "Limited snapshot."}).waitFor();
    const actions = page.getByRole("link", {name: "Actions: 200+ for you, 200+ total open", exact: true});
    await actions.waitFor();
    await mkdir(".artifacts/source-160-bounded-aggregate", {recursive: true});
    await page.screenshot({path: ".artifacts/source-160-bounded-aggregate/dashboard.png", fullPage: true});
    await actions.click();
    await page.getByRole("heading", {name: "Action section fixture"}).waitFor();
    expect(new URL(page.url()).searchParams.getAll("status")).toEqual(["OPEN", "IN_PROGRESS"]);
  } finally {
    state.realTranslations = false;
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30000);
