import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedSqlDefinition } from "./native-definition";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), describe: vi.fn(), page: vi.fn(), end: vi.fn() }));
vi.mock("./postgres", () => ({ connectReadOnly: mocks.connect, describeTable: mocks.describe, pullPage: mocks.page,
  usesTemporalTextDecoding: (definition: CapturedSqlDefinition, name: string) =>
    [1082, 1114, 1184, 1182, 1115, 1185].includes(definition.columns.find((column) => column.name === name)!.typeOid),
}));
vi.mock("./encryption", () => ({ decrypt: () => "synthetic-provider" }));
import { capturePostgresScan } from "./native-scan";

const key = { name: "id", type: "int4" as const, typeOid: 23, typeModifier: -1, collationOid: 0 };
const definition: CapturedSqlDefinition = { schema: "public", name: "events", relationOid: 1, cursor: key, key: [key],
  columns: [{ ...key, position: 1, isNullable: false, identity: "", generated: "" }] };
const source = { id: "source", workspaceId: "workspace", driverType: "postgres", connectionStringEnc: "sealed",
  cursorColumn: "id", selectedTables: ["public.events"], lastCursorValue: null };
const client = { end: mocks.end };
const lost = new Error("authority revoked during native operation");
let cancelled: boolean;
const assertCurrentSource = async () => { if (cancelled) throw lost; };

beforeEach(() => {
  vi.resetAllMocks();
  cancelled = false;
  mocks.connect.mockResolvedValue(client);
  mocks.describe.mockResolvedValue(definition);
  mocks.page.mockResolvedValue({ rows: [{ row: { id: 1 }, values: ["1"] }] });
  mocks.end.mockResolvedValue(undefined);
});

describe("native capture authority boundaries", () => {
  it("closes exactly once when authority is revoked while connection setup resolves", async () => {
    mocks.connect.mockImplementation(async () => { cancelled = true; return client; });
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toBe(lost);
    expect(mocks.describe).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("stops before paging when authority is revoked during metadata discovery", async () => {
    mocks.describe.mockImplementation(async () => { cancelled = true; return definition; });
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toBe(lost);
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("never returns the final page after authority was revoked during its await", async () => {
    mocks.page.mockImplementation(async () => { cancelled = true; return { rows: [{ row: { id: 1 }, values: ["1"] }] }; });
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toBe(lost);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("rejects revoked pre-publication authority before querying metadata", async () => {
    const captured = await capturePostgresScan(source, assertCurrentSource);
    const describes = mocks.describe.mock.calls.length;
    cancelled = true;
    await expect(captured.beforePublication()).rejects.toBe(lost);
    expect(mocks.describe).toHaveBeenCalledTimes(describes);
    await captured.dispose();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("preserves provider failures unless an authority check actually fails", async () => {
    const providerFailure = new Error("native SELECT failed");
    mocks.page.mockRejectedValueOnce(providerFailure);
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toBe(providerFailure);
    mocks.page.mockImplementationOnce(async () => { cancelled = true; throw providerFailure; });
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toBe(lost);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it("retains full native metadata while keeping v1 checkpoint serialization compatible", async () => {
    const captured = await capturePostgresScan(source, assertCurrentSource);
    expect(captured.rows[0].definition.columns).toEqual(definition.columns);
    expect(captured.pages[0].definition.columns).toEqual(definition.columns);
    expect(JSON.parse(captured.nextCursor).tables["public.events"].definition).not.toHaveProperty("columns");
    await captured.dispose();
  });

  it("does not let exact temporal decoding silently change legacy Date primary-key identities", async () => {
    const dateKey = { ...key, type: "date" as const, typeOid: 1082 };
    mocks.describe.mockResolvedValue({ ...definition, cursor: dateKey, key: [dateKey],
      columns: [{ ...dateKey, position: 1, isNullable: false, identity: "", generated: "" }] });
    mocks.page.mockResolvedValue({ rows: [{ row: { id: "2026-10-12" }, values: ["2026-10-12"] }] });
    await expect(capturePostgresScan(source, assertCurrentSource)).rejects.toThrow("CURSOR_IDENTITY_CHANGED");
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("preserves the publication metadata failure if connection cleanup also fails", async () => {
    const captured = await capturePostgresScan(source, assertCurrentSource);
    const metadataFailure = new Error("native metadata unavailable");
    mocks.describe.mockRejectedValue(metadataFailure);
    mocks.end.mockRejectedValue(new Error("close failed"));
    await expect(captured.beforePublication()).rejects.toBe(metadataFailure);
    await captured.dispose();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("rejects payload DDL changes in the post-preparation publication hook", async () => {
    const captured = await capturePostgresScan(source, assertCurrentSource);
    mocks.describe.mockResolvedValue({ ...definition, columns: [...definition.columns,
      { name: "new_payload", type: "text", typeOid: 25, typeModifier: -1, collationOid: 100,
        position: 2, isNullable: true, identity: "", generated: "" }] });
    await expect(captured.beforePublication()).rejects.toThrow("CURSOR_DEFINITION_CHANGED");
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
