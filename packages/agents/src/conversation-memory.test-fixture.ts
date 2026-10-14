import { vi } from "vitest";

export const memoryFixture = (() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  const chat = vi.fn(); const eventStream = vi.fn(); const chatStream = vi.fn();
  const embedding = vi.fn(); const rerank = vi.fn(); const cache = new Map<string, any>();
  const updateHook = { current: null as null | ((delegate: string, row: any) => void) };
  const transactionErrors: Error[] = [];
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {}) as Array<[string, any]>) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (value === undefined) continue;
      else if (key === "conversation") { if (!matches(tables.get("conversationSession")?.get(row.conversationId), value)) return false; }
      else if (["account", "contact", "deal"].includes(key) && value && typeof value === "object") {
        const related = row[`${key}Id`] ? tables.get(`crm${key[0].toUpperCase()}${key.slice(1)}`)?.get(row[`${key}Id`]) : null;
        if ("is" in value ? !matches(related, value.is) : !matches(related, value)) return false;
      }
      else if (value && typeof value === "object" && "path" in value) { if (row[key]?.[value.path[0]] !== value.equals) return false; }
      else if (value && typeof value === "object" && "not" in value) { if ((row[key] ?? null) === value.not) return false; }
      else if (value && typeof value === "object" && "lt" in value) { if (!(row[key] < value.lt)) return false; }
      else if (value && typeof value === "object" && "gt" in value) { if (!(row[key] > value.gt)) return false; }
      else if (value && typeof value === "object" && "some" in value) { if (!Array.isArray(row[key]) || !row[key].some((entry: any) => matches(entry, value.some))) return false; }
      else if (value && typeof value === "object" && key.includes("_")) { if (!matches(row, value)) return false; }
      else if ((row[key] ?? null) !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const bases = { primary: { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) },
    tx: { $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) } };
  const boundary = { inTransaction: false };
  function client(clientName: "primary" | "tx"): any { return new Proxy(bases[clientName], { get(target, property) {
    if (clientName === "primary" && boundary.inTransaction) throw new Error(`Global database read/write inside memory tx: ${String(property)}`);
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    const delegateKey = `${clientName}:${name}`;
    if (!delegates.has(delegateKey)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(Array.isArray(orderBy) ? Object.assign({}, ...orderBy) : orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(delegateKey, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null), findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        count: vi.fn(async (args) => find(args).length),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: name === "conversationPendingOperation" ? `123e4567-e89b-12d3-a456-${String(++serial).padStart(12, "0")}` : `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          updateHook.current?.(name, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          updateHook.current?.(name, row);
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(delegateKey);
  } }); }
  const prisma = client("primary"); const tx = client("tx"); const base = bases.primary;
  return { tables, memberships, delegates, membership, prisma, tx, base, bases, boundary, chat, eventStream, chatStream, embedding, rerank, cache, updateHook, transactionErrors };
})();
