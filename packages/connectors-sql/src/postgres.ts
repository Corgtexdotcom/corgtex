import pg from "pg";
const { Client } = pg;

export async function connectReadOnly(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  
  // Enforce read-only safety guards
  await client.query("SET statement_timeout = 30000"); // 30 seconds
  await client.query("SET default_transaction_read_only = on");
  return client;
}

export async function listTables(client: pg.Client): Promise<string[]> {
  const query = `
    SELECT table_schema || '.' || table_name as full_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  `;
  const result = await client.query(query);
  return result.rows.map((row: any) => row.full_name);
}

export async function pullRows(
  client: pg.Client,
  table: string,
  cursorCol: string,
  lastValue: string | null,
  limit: number
): Promise<Record<string, unknown>[]> {
  const parts = table.split(".");
  const schema = parts.length > 1 ? parts[0] : "public";
  const name = parts.length > 1 ? parts[1] : parts[0];
  
  const safeSchema = `"${schema.replace(/"/g, '""')}"`;
  const safeName = `"${name.replace(/"/g, '""')}"`;
  const safeCursor = `"${cursorCol.replace(/"/g, '""')}"`;

  let queryText = `SELECT * FROM ${safeSchema}.${safeName}`;
  const queryValues: unknown[] = [];

  if (lastValue) {
    queryText += ` WHERE ${safeCursor} > $1`;
    queryValues.push(lastValue);
  }

  queryText += ` ORDER BY ${safeCursor} ASC LIMIT $${queryValues.length + 1}`;
  queryValues.push(limit);

  const result = await client.query(queryText, queryValues);
  return result.rows;
}
