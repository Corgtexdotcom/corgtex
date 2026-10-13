import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorColumn, CursorState, TableDefinition } from "./cursor";

const mocked = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  logCreate: vi.fn(),
  logUpdate: vi.fn(),
  knowledge: vi.fn(),
  decrypt: vi.fn(),
  connect: vi.fn(),
  describeTable: vi.fn(),
  pullPage: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    externalDataSource: {
      findUnique: mocked.findUnique,
      update: mocked.update,
      updateMany: mocked.updateMany,
    },
    externalDataSyncLog: { create: mocked.logCreate, update: mocked.logUpdate },
  },
}));
vi.mock("@corgtex/knowledge", () => ({ syncKnowledgeForSource: mocked.knowledge }));
vi.mock("./encryption", () => ({ decrypt: mocked.decrypt }));
vi.mock("./postgres", () => ({
  connectReadOnly: mocked.connect,
  describeTable: mocked.describeTable,
  pullPage: mocked.pullPage,
}));

import { syncExternalDataSource } from "./puller";

type SourceFixture = {
  id: string;
  workspaceId: string;
  isActive: boolean;
  driverType: string;
  connectionStringEnc: string;
  cursorColumn: string;
  selectedTables: string[];
  lastCursorValue: string | null;
  lastSyncError: string | null;
  lastSyncAt?: Date;
  updatedAt?: Date;
};
type KnowledgeInput = {
  workspaceId: string;
  sourceType: string;
  accessDomain: string;
  sourceId: string;
  sourceTitle: string;
  content: string;
  metadata: { table: string; sourceId: string };
};
type PageRow = { row: Record<string, unknown>; values: string[] };
type Page = { rows: PageRow[] };
type CheckpointWrite = { where: Record<string, unknown>; data: Partial<SourceFixture> };

const table = "public.records";
const client = { end: mocked.end };
let source: SourceFixture;
let definitions: Map<string, TableDefinition>;
let pages: Map<string, Page[]>;
let knowledgeCalls: KnowledgeInput[];
let committedKnowledge: Map<string, KnowledgeInput>;
let checkpointWrites: CheckpointWrite[];
let statusWrites: CheckpointWrite[];

function column(name: string, type: CursorColumn["type"] = "int4"): CursorColumn {
  const oids = { int4: 23, int8: 20, timestamptz: 1184, date: 1082, uuid: 2950, text: 25 };
  return { name, type, typeOid: oids[type as keyof typeof oids], typeModifier: -1, collationOid: 0 };
}

function definition(token = table, cursor = column("seq"), key = [column("id")]): TableDefinition {
  const [schema, name] = token.split(".");
  return { schema, name, relationOid: 101, cursor, key };
}

function page(...rows: PageRow[]): Page {
  return { rows };
}

function row(id: string | number, seq: string | number = id): PageRow {
  return { row: { id, seq, payload: `row-${id}` }, values: [String(seq), String(id)] };
}

function fullPage(firstId: number): Page {
  return page(...Array.from({ length: 1000 }, (_, offset) => row(firstId + offset)));
}

function setPages(token: string, ...values: Page[]) {
  if (!definitions.has(token)) definitions.set(token, definition(token));
  pages.set(token, values);
}

function checkpoint(): CursorState {
  return JSON.parse(source.lastCursorValue!);
}

function expectNoSourceIo() {
  expect(mocked.connect).not.toHaveBeenCalled();
  expect(mocked.describeTable).not.toHaveBeenCalled();
  expect(mocked.pullPage).not.toHaveBeenCalled();
  expect(mocked.knowledge).not.toHaveBeenCalled();
  expectNoCheckpointWrite();
}

function expectNoCheckpointWrite() {
  expect(mocked.updateMany.mock.calls.filter(([write]) => "lastCursorValue" in write.data)).toHaveLength(0);
}

async function seedCheckpoint() {
  setPages(table, page(row(1)));
  await syncExternalDataSource(source.id);
  for (const mock of Object.values(mocked)) mock.mockClear();
  knowledgeCalls = [];
  checkpointWrites = [];
  statusWrites = [];
}

beforeEach(() => {
  vi.resetAllMocks();
  source = {
    id: "source-1",
    workspaceId: "workspace-1",
    isActive: true,
    driverType: "postgres",
    connectionStringEnc: "synthetic-encrypted-placeholder",
    cursorColumn: "seq",
    selectedTables: [table],
    lastCursorValue: null,
    lastSyncError: null,
  };
  definitions = new Map([[table, definition()]]);
  pages = new Map();
  knowledgeCalls = [];
  committedKnowledge = new Map();
  checkpointWrites = [];
  statusWrites = [];
  mocked.findUnique.mockImplementation(async () => structuredClone(source));
  mocked.update.mockImplementation(async ({ data }: { data: Partial<SourceFixture> }) => {
    Object.assign(source, data);
    return structuredClone(source);
  });
  mocked.updateMany.mockImplementation(async (write: CheckpointWrite) => {
    if ("lastCursorValue" in write.data) checkpointWrites.push(write);
    else statusWrites.push(write);
    const matches = Object.entries(write.where).every(([key, expected]) => {
      const actual = source[key as keyof SourceFixture];
      if (expected !== null && typeof expected === "object" && "equals" in expected) {
        return JSON.stringify(actual) === JSON.stringify(expected.equals);
      }
      return actual === expected;
    });
    if (!matches) return { count: 0 };
    Object.assign(source, write.data);
    return { count: 1 };
  });
  mocked.logCreate.mockResolvedValue({ id: "log-1" });
  mocked.logUpdate.mockResolvedValue({ id: "log-1" });
  mocked.decrypt.mockReturnValue("postgresql://synthetic-local-only");
  mocked.connect.mockResolvedValue(client);
  mocked.end.mockResolvedValue(undefined);
  mocked.describeTable.mockImplementation(async (_client, token: string) => {
    const value = definitions.get(token);
    if (!value) throw new Error(`No synthetic table definition: ${token}`);
    return structuredClone(value);
  });
  mocked.pullPage.mockImplementation(async (_client, value: TableDefinition, _bookmark, limit: number) => {
    expect(limit).toBe(1000);
    return pages.get(`${value.schema}.${value.name}`)?.shift() ?? page();
  });
  mocked.knowledge.mockImplementation(async (input: KnowledgeInput) => {
    knowledgeCalls.push(input);
    committedKnowledge.set(input.sourceId, input);
    return 2;
  });
});

describe("typed SQL ingestion checkpoints", () => {
  it.each([null, "{}"])("bootstraps only the permitted empty checkpoint %j", async (initialCursor) => {
    source.lastCursorValue = initialCursor;
    setPages(table, page(row(1)));

    await syncExternalDataSource(source.id);

    expect(checkpoint()).toMatchObject({ version: 1, nextTable: null, tables: {
      [table]: { definition: definition(), values: ["1", "1"] },
    } });
    expect(checkpoint().scanFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(mocked.pullPage).toHaveBeenCalledWith(client, definition(), null, 1000);
    expect(mocked.updateMany).toHaveBeenCalledOnce();
    expect(mocked.end).toHaveBeenCalledOnce();
  });

  it("advances 999 -> 1000 from the database page tail and resumes that tuple", async () => {
    setPages(table, page(row(999), row(1000)));
    await syncExternalDataSource(source.id);
    expect(checkpoint().tables[table].values).toEqual(["1000", "1000"]);

    setPages(table, page(row(1001)));
    await syncExternalDataSource(source.id);

    expect(mocked.pullPage.mock.calls[1]).toEqual([client, definition(), ["1000", "1000"], 1000]);
    expect(checkpoint().tables[table].values).toEqual(["1001", "1001"]);
    expect(knowledgeCalls.map((input) => input.sourceId)).toEqual([
      `byodb:${source.id}:${table}:999`, `byodb:${source.id}:${table}:1000`, `byodb:${source.id}:${table}:1001`,
    ]);
  });

  it("resumes an exact compatible version-1 tuple including its key without resetting progress or identities", async () => {
    setPages(table, page(row(41, 999)));
    await syncExternalDataSource(source.id);
    const savedCursor = source.lastCursorValue;
    const savedState = checkpoint();
    expect(savedState.tables[table].values).toEqual(["999", "41"]);
    setPages(table, page(row(42, 999)));

    await syncExternalDataSource(source.id);

    expect(mocked.pullPage.mock.calls[1]).toEqual([client, definition(), ["999", "41"], 1000]);
    expect(checkpoint().version).toBe(1);
    expect(checkpoint().scanFingerprint).toBe(savedState.scanFingerprint);
    expect(checkpoint().tables[table]).toEqual({ definition: savedState.tables[table].definition, values: ["999", "42"] });
    expect(checkpointWrites[1].where.lastCursorValue).toBe(savedCursor);
    expect(knowledgeCalls.map((input) => input.sourceId)).toEqual([
      `byodb:${source.id}:${table}:41`, `byodb:${source.id}:${table}:42`,
    ]);
    expect(checkpointWrites.every((write) => typeof write.data.lastCursorValue === "string")).toBe(true);
  });

  it("uses exact SQL bigint and timestamp tuple fields rather than decoded Date values", async () => {
    const preciseTimestamp = "2026-01-01 00:00:00.123456+00";
    const exactId = "9007199254740993";
    source.cursorColumn = "changed_at";
    const metadata = definition(table, column("changed_at", "timestamptz"), [column("id", "int8")]);
    definitions.set(table, metadata);
    setPages(table, page({ row: { id: exactId, changed_at: new Date("2026-01-01T00:00:00.123Z") },
      values: [preciseTimestamp, exactId] }));

    await syncExternalDataSource(source.id);

    expect(checkpoint().tables[table].values).toEqual([preciseTimestamp, exactId]);
    expect(knowledgeCalls[0].sourceId).toBe(`byodb:${source.id}:${table}:${exactId}`);
    setPages(table, page());
    await syncExternalDataSource(source.id);
    expect(mocked.pullPage.mock.calls[1]).toEqual([client, metadata, [preciseTimestamp, exactId], 1000]);
  });

  it("drains more than 1000 tied timestamps using the unique tuple boundary", async () => {
    const timestamp = "2026-01-01 00:00:00.123456+00";
    source.cursorColumn = "changed_at";
    const metadata = definition(table, column("changed_at", "timestamptz"), [column("id", "int8")]);
    definitions.set(table, metadata);
    const rows = Array.from({ length: 1501 }, (_, index) => ({
      row: { id: String(index + 1), changed_at: new Date("2026-01-01T00:00:00.123Z") },
      values: [timestamp, String(index + 1)],
    }));
    setPages(table, page(...rows.slice(0, 1000)), page(...rows.slice(1000)));

    await syncExternalDataSource(source.id);

    expect(mocked.pullPage.mock.calls.map((call) => call[2])).toEqual([null, [timestamp, "1000"]]);
    expect(knowledgeCalls).toHaveLength(1501);
    expect(new Set(knowledgeCalls.map((input) => input.sourceId)).size).toBe(1501);
    expect(checkpoint().tables[table].values).toEqual([timestamp, "1501"]);
    expect(mocked.updateMany).toHaveBeenCalledOnce();
  });

  it("bounds work to ten pages, shares pages across tables, and resumes the next table fairly", async () => {
    const tables = ["public.alpha", "public.beta", "public.gamma"];
    source.selectedTables = tables;
    for (const token of tables) setPages(token, fullPage(1), fullPage(1001), fullPage(2001), fullPage(3001));

    await syncExternalDataSource(source.id);

    expect(mocked.pullPage).toHaveBeenCalledTimes(10);
    expect(mocked.pullPage.mock.calls.map((call) => call[1].name)).toEqual([
      "alpha", "beta", "gamma", "alpha", "beta", "gamma", "alpha", "beta", "gamma", "alpha",
    ]);
    expect(knowledgeCalls).toHaveLength(10_000);
    expect(checkpoint().nextTable).toBe("public.beta");
    expect(checkpoint().tables["public.alpha"].values).toEqual(["4000", "4000"]);
    expect(checkpoint().tables["public.beta"].values).toEqual(["3000", "3000"]);
    expect(mocked.updateMany).toHaveBeenCalledOnce();
    mocked.pullPage.mockClear();

    await syncExternalDataSource(source.id);

    expect(mocked.pullPage.mock.calls[0]).toEqual([client, definition("public.beta"), ["3000", "3000"], 1000]);
    expect(checkpoint().nextTable).toBeNull();
    expect(knowledgeCalls).toHaveLength(12_000);
    expect(mocked.updateMany).toHaveBeenCalledTimes(2);
  });

  it("stops requesting pages from a table after a short page", async () => {
    source.selectedTables = ["public.alpha", "public.beta"];
    setPages("public.alpha", page(row(1)));
    setPages("public.beta", fullPage(1), page(row(1001)));

    await syncExternalDataSource(source.id);

    expect(mocked.pullPage.mock.calls.map((call) => call[1].name)).toEqual(["alpha", "beta", "beta"]);
    expect(checkpoint().nextTable).toBeNull();
  });

  it("keeps the existing knowledge source contract and identity format", async () => {
    setPages(table, page(row(1)));

    await syncExternalDataSource(source.id);

    expect(mocked.knowledge).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_DATABASE",
      accessDomain: "WORKSPACE",
      sourceId: `byodb:source-1:${table}:1`,
      sourceTitle: `${table} row 1`,
      content: "id: 1\nseq: 1\npayload: row-1",
      metadata: { table, sourceId: "source-1" },
    });
    expect(mocked.logUpdate).toHaveBeenLastCalledWith({ where: { id: "log-1" }, data: {
      rowsProcessed: 1, chunksCreated: 2, completedAt: expect.any(Date),
    } });
    expect(checkpointWrites[0].data).toMatchObject({ lastSyncAt: expect.any(Date), lastSyncError: null });
  });
});

describe("cursor compatibility and validation", () => {
  it.each([
    ["malformed", "{malformed", /CURSOR_INVALID/],
    ["nonempty legacy", JSON.stringify({ [table]: "999" }), /CURSOR_LEGACY_REPLAY_REQUIRED/],
    ["JSON null", "null", /CURSOR_INVALID/],
    ["array", "[]", /CURSOR_INVALID/],
    ["scalar", "1", /CURSOR_INVALID/],
    ["empty text", "", /CURSOR_INVALID/],
    ["unsupported version", JSON.stringify({ version: 2, scanFingerprint: "a".repeat(64), nextTable: null, tables: {} }), /CURSOR_VERSION_UNSUPPORTED/],
  ] as const)("rejects %s checkpoint before connecting, without resetting it", async (_label, cursor, error) => {
    source.lastCursorValue = cursor as string;

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(error as RegExp);

    expect(source.lastCursorValue).toBe(cursor);
    expectNoSourceIo();
    expect(mocked.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: source.id, lastCursorValue: cursor }), data: {
      lastSyncError: expect.any(String),
    } });
  });

  it.each(["connection", "cursor column"] as const)("keeps an exact-looking legacy scalar paused when its %s provenance is unknown", async (changedConfiguration) => {
    await seedCheckpoint();
    const historicalRows = [...committedKnowledge.entries()];
    const legacyCursor = JSON.stringify({ [table]: "999" });
    source.lastCursorValue = legacyCursor;
    if (changedConfiguration === "connection") source.connectionStringEnc = "replacement-connection-with-no-history";
    else source.cursorColumn = "replacement_cursor";
    setPages(table, page(row(1000)));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_LEGACY_REPLAY_REQUIRED/);

    expect(mocked.decrypt).not.toHaveBeenCalled();
    expectNoSourceIo();
    expect(source.lastCursorValue).toBe(legacyCursor);
    expect([...committedKnowledge.entries()]).toEqual(historicalRows);
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("rejects a legacy id checkpoint despite a unique current id cursor and freshly refreshed success timestamps", async () => {
    await seedCheckpoint();
    const historicalRows = [...committedKnowledge.entries()];
    const legacyCursor = JSON.stringify({ [table]: "1000" });
    const refreshedAt = new Date("2026-10-13T19:30:00Z");
    source.cursorColumn = "id";
    source.lastCursorValue = legacyCursor;
    // A prior old zero-row success can refresh these timestamps without
    // recording which connection or cursor originally produced the checkpoint.
    source.lastSyncAt = refreshedAt;
    source.updatedAt = refreshedAt;
    definitions.set(table, definition(table, column("id"), [column("id")]));
    setPages(table, page({ row: { id: 1001, payload: "next-id" }, values: ["1001"] }));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_LEGACY_REPLAY_REQUIRED/);

    expect(mocked.decrypt).not.toHaveBeenCalled();
    expectNoSourceIo();
    expect(source.lastCursorValue).toBe(legacyCursor);
    expect(source.lastSyncAt).toEqual(refreshedAt);
    expect(source.updatedAt).toEqual(refreshedAt);
    expect([...committedKnowledge.entries()]).toEqual(historicalRows);
  });

  it.each([
    ["workspace", () => { source.workspaceId = "workspace-2"; }],
    ["connection", () => { source.connectionStringEnc = "changed-placeholder"; }],
    ["cursor column", () => { source.cursorColumn = "changed_at"; }],
    ["selected tables", () => { source.selectedTables = [table, "public.other"]; }],
  ] as const)("rejects a saved checkpoint after %s configuration changes before connecting", async (_label, mutate) => {
    await seedCheckpoint();
    const original = source.lastCursorValue;
    mutate();

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/configuration|CONFIGURATION|CURSOR.*CHANGED/);

    expect(source.lastCursorValue).toBe(original);
    expectNoSourceIo();
  });

  it("rejects a changed relation definition before requesting or ingesting a page", async () => {
    await seedCheckpoint();
    const original = source.lastCursorValue;
    definitions.set(table, { ...definition(), relationOid: 102 });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_DEFINITION_CHANGED/);

    expect(mocked.pullPage).not.toHaveBeenCalled();
    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBe(original);
    expect(mocked.end).toHaveBeenCalledOnce();
  });

  it("detects metadata changes during a fresh short page before persisting its first checkpoint", async () => {
    setPages(table, page(row(1)));
    mocked.knowledge.mockImplementationOnce(async () => {
      definitions.set(table, { ...definition(), relationOid: 102 });
      return 2;
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_DEFINITION_CHANGED/);

    expect(mocked.knowledge).toHaveBeenCalledOnce();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
    expect(mocked.end).toHaveBeenCalledOnce();
  });

  it("detects metadata changes before querying the next page", async () => {
    setPages(table, fullPage(1), page(row(1001)));
    mocked.knowledge.mockImplementationOnce(async () => {
      definitions.set(table, definition(table, { ...column("seq"), typeModifier: 12 }));
      return 2;
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_DEFINITION_CHANGED/);

    expect(mocked.pullPage).toHaveBeenCalledOnce();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
  });

  it("rejects an unsupported driver without opening its connection", async () => {
    source.driverType = "mysql";

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/Unsupported driver/);

    expectNoSourceIo();
  });

  it("rejects inactive sources without any ingestion or checkpoint attempt", async () => {
    source.isActive = false;

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/inactive/);

    expectNoSourceIo();
    expect(mocked.logCreate).not.toHaveBeenCalled();
  });

  it("rejects composite identities before a page is ingested", async () => {
    definitions.set(table, definition(table, column("seq"), [column("id"), column("tenant_id")]));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/IDENTITY|composite|scalar/i);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
  });

  it.each([null, "{}"])("does not use bootstrap checkpoint %j to bypass whole-page identity migration checks", async (initialCursor) => {
    source.lastCursorValue = initialCursor;
    setPages(table, page(row(1), { row: { seq: 100, id: 0 }, values: ["100", "0"] }));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_IDENTITY_CHANGED/);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBe(initialCursor);
  });

  it("preserves bigint zero when the old driver identity remains compatible", async () => {
    definitions.set(table, definition(table, column("seq"), [column("id", "int8")]));
    setPages(table, page({ row: { seq: 100, id: "0" }, values: ["100", "0"] }));

    await syncExternalDataSource(source.id);

    expect(knowledgeCalls[0].sourceId).toBe(`byodb:${source.id}:${table}:0`);
    expect(checkpoint().tables[table].values).toEqual(["100", "0"]);
  });

  it("rejects a non-key legacy id rather than assigning the row a new identity", async () => {
    definitions.set(table, definition(table, column("seq"), [column("external_key", "text")]));
    setPages(table, page({ row: { id: "legacy-id", seq: 1, external_key: "actual-key" }, values: ["1", "actual-key"] }));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_IDENTITY_CHANGED/);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
  });

  it("preserves a compatible legacy uuid identity", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    definitions.set(table, definition(table, column("seq"), [column("uuid", "uuid")]));
    setPages(table, page({ row: { uuid, seq: 1 }, values: ["1", uuid] }));

    await syncExternalDataSource(source.id);

    expect(knowledgeCalls[0].sourceId).toBe(`byodb:${source.id}:${table}:${uuid}`);
    expect(checkpoint().tables[table].values).toEqual(["1", uuid]);
  });

  it("requires an explicit identity migration when decoded Date keys differ from SQL text", async () => {
    definitions.set(table, definition(table, column("seq"), [column("day", "date")]));
    setPages(table, page({ row: { day: new Date("2026-01-01T00:00:00Z"), seq: 1 },
      values: ["1", "2026-01-01"] }));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_IDENTITY_CHANGED/);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
  });

  it("propagates SQL null-cursor validation without checkpointing and can retry after correction", async () => {
    mocked.pullPage.mockRejectedValueOnce(new Error("CURSOR_NULL_UNSUPPORTED: synthetic SQL null cursor"));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_NULL_UNSUPPORTED/);

    expect(source.lastCursorValue).toBeNull();
    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
    setPages(table, page(row(1)));
    await syncExternalDataSource(source.id);
    expect(checkpoint().tables[table].values).toEqual(["1", "1"]);
  });

  it("rejects a malformed page tuple before any row from that page is ingested", async () => {
    setPages(table, page(row(1), { row: { id: 2, seq: 2 }, values: ["2"] }));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_PAGE_INVALID/);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
  });

  it("rejects a page exceeding its requested limit before ingestion", async () => {
    setPages(table, page(...fullPage(1).rows, row(1001)));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_PAGE_INVALID/);

    expect(mocked.knowledge).not.toHaveBeenCalled();
    expectNoCheckpointWrite();
  });
});

describe("checkpoint and retry boundaries", () => {
  it.each(["before", "after"] as const)("retries the page when knowledge fails %s its simulated commit", async (phase) => {
    setPages(table, page(row(1), row(2), row(3)));
    mocked.knowledge.mockImplementation(async (input: KnowledgeInput) => {
      knowledgeCalls.push(input);
      const shouldFail = knowledgeCalls.length === 2;
      if (shouldFail && phase === "before") throw new Error("knowledge acknowledgement failed");
      committedKnowledge.set(input.sourceId, input);
      if (shouldFail) throw new Error("knowledge acknowledgement failed");
      return 2;
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("knowledge acknowledgement failed");

    expect(source.lastCursorValue).toBeNull();
    expectNoCheckpointWrite();
    expect(committedKnowledge.size).toBe(phase === "before" ? 1 : 2);
    expect(mocked.end).toHaveBeenCalledOnce();
    setPages(table, page(row(1), row(2), row(3)));
    await syncExternalDataSource(source.id);
    expect(knowledgeCalls.slice(2).map((input) => input.sourceId)).toEqual([
      `byodb:${source.id}:${table}:1`, `byodb:${source.id}:${table}:2`, `byodb:${source.id}:${table}:3`,
    ]);
    expect(checkpoint().tables[table].values).toEqual(["3", "3"]);
  });

  it("does not persist any table tail when ingestion fails after another table completed", async () => {
    source.selectedTables = [table, "public.other"];
    setPages(table, page(row(1)));
    setPages("public.other", page(row(1)));
    mocked.knowledge.mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("second table failed"));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("second table failed");

    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
    expect(mocked.end).toHaveBeenCalledOnce();
  });

  it.each(["before", "after"] as const)("retries correctly when checkpoint acknowledgement fails %s simulated commit", async (phase) => {
    setPages(table, page(row(1), row(2)));
    mocked.updateMany.mockImplementationOnce(async (write: CheckpointWrite) => {
      if (phase === "after") Object.assign(source, write.data);
      throw new Error("checkpoint acknowledgement failed");
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("checkpoint acknowledgement failed");

    expect(knowledgeCalls).toHaveLength(2);
    if (phase === "before") expect(source.lastCursorValue).toBeNull();
    else expect(checkpoint().tables[table].values).toEqual(["2", "2"]);
    setPages(table, phase === "before" ? page(row(1), row(2)) : page());
    await syncExternalDataSource(source.id);
    expect(knowledgeCalls).toHaveLength(phase === "before" ? 4 : 2);
    expect(checkpoint().tables[table].values).toEqual(["2", "2"]);
  });

  it("keeps an acknowledged checkpoint when the completion log fails", async () => {
    setPages(table, page(row(1)));
    mocked.logUpdate.mockRejectedValueOnce(new Error("completion log failed"));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("completion log failed");

    expect(checkpoint().tables[table].values).toEqual(["1", "1"]);
    expect(source.lastSyncError).toBe("completion log failed");
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].where).toMatchObject({
      id: source.id, workspaceId: source.workspaceId, isActive: true,
      connectionStringEnc: source.connectionStringEnc, cursorColumn: source.cursorColumn,
      selectedTables: { equals: [table] }, lastCursorValue: source.lastCursorValue,
    });
    expect(mocked.update).not.toHaveBeenCalled();
    setPages(table, page());
    await syncExternalDataSource(source.id);
    expect(knowledgeCalls).toHaveLength(1);
    expect(source.lastSyncError).toBeNull();
  });

  it("reports its own cleanup failure against the acknowledged checkpoint", async () => {
    setPages(table, page(row(1)));
    mocked.end.mockRejectedValueOnce(new Error("source connection cleanup failed"));

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("source connection cleanup failed");

    expect(checkpoint().tables[table].values).toEqual(["1", "1"]);
    expect(source.lastSyncError).toBe("source connection cleanup failed");
    expect(statusWrites[0].where.lastCursorValue).toBe(source.lastCursorValue);
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("does not let an obsolete ingestion failure overwrite a winning run's status", async () => {
    await seedCheckpoint();
    const originalCursor = source.lastCursorValue;
    const winningState = checkpoint();
    winningState.tables[table].values = ["50", "50"];
    const winningCursor = JSON.stringify(winningState);
    setPages(table, page(row(2)));
    mocked.knowledge.mockImplementationOnce(async () => {
      source.lastCursorValue = winningCursor;
      source.lastSyncError = "winning run diagnostic";
      throw new Error("obsolete ingestion failed");
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("obsolete ingestion failed");

    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBe(winningCursor);
    expect(source.lastSyncError).toBe("winning run diagnostic");
    expect(statusWrites[0].where.lastCursorValue).toBe(originalCursor);
    expect(mocked.logUpdate).toHaveBeenCalledWith({ where: { id: "log-1" }, data: {
      error: "obsolete ingestion failed", completedAt: expect.any(Date),
    } });
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("does not overwrite newer status after an ambiguously committed checkpoint loses its acknowledgement", async () => {
    setPages(table, page(row(1)));
    mocked.updateMany.mockImplementationOnce(async (write: CheckpointWrite) => {
      expect(write.data.lastCursorValue).toBeTypeOf("string");
      Object.assign(source, write.data);
      source.lastSyncError = "newer run diagnostic";
      throw new Error("checkpoint acknowledgement lost");
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow("checkpoint acknowledgement lost");

    expect(checkpoint().tables[table].values).toEqual(["1", "1"]);
    expect(source.lastSyncError).toBe("newer run diagnostic");
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].where.lastCursorValue).toBeNull();
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("uses one compare-and-swap checkpoint against the initial cursor and complete configuration", async () => {
    setPages(table, page(row(1)));

    await syncExternalDataSource(source.id);

    expect(mocked.updateMany).toHaveBeenCalledOnce();
    expect(checkpointWrites[0].where).toMatchObject({
      id: "source-1", workspaceId: "workspace-1", isActive: true, driverType: "postgres",
      connectionStringEnc: "synthetic-encrypted-placeholder", cursorColumn: "seq",
      selectedTables: { equals: [table] }, lastCursorValue: null,
    });
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it("rejects a concurrent checkpoint conflict without overwriting the stored cursor", async () => {
    await seedCheckpoint();
    const original = source.lastCursorValue;
    setPages(table, page(row(2)));
    mocked.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/conflict|CURSOR.*CONCURRENT|configuration.*changed/i);

    expect(source.lastCursorValue).toBe(original);
    expect(mocked.updateMany).toHaveBeenLastCalledWith({ where: expect.objectContaining({ id: source.id, lastCursorValue: original }), data: {
      lastSyncError: expect.any(String),
    } });
  });

  it("detects an in-flight configuration edit at compare-and-swap without checkpoint reset", async () => {
    setPages(table, page(row(1)));
    mocked.knowledge.mockImplementationOnce(async () => {
      source.connectionStringEnc = "concurrent-replacement";
      return 2;
    });
    mocked.updateMany.mockImplementationOnce(async (write: CheckpointWrite) => {
      expect(write.where.connectionStringEnc).toBe("synthetic-encrypted-placeholder");
      expect(write.where.lastCursorValue).toBeNull();
      return { count: 0 };
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/conflict|CURSOR.*CONCURRENT|configuration.*changed/i);

    expect(source.connectionStringEnc).toBe("concurrent-replacement");
    expect(source.lastCursorValue).toBeNull();
  });

  it("stops before requesting another page when the source configuration changes during ingestion", async () => {
    setPages(table, fullPage(1), page(row(1001)));
    mocked.knowledge.mockImplementationOnce(async () => {
      source.connectionStringEnc = "concurrent-replacement";
      return 2;
    });

    await expect(syncExternalDataSource(source.id)).rejects.toThrow(/CURSOR_SCAN_CHANGED/);

    expect(mocked.pullPage).toHaveBeenCalledOnce();
    expectNoCheckpointWrite();
    expect(source.lastCursorValue).toBeNull();
  });
});
