import { schemaTokenDigest, tokenizeSchemaDump } from "./postgres-schema-tokens.mjs";
import { verifyBoundOrderedAnd } from "./postgres-check-structure.mjs";

export const REPRESENTATION_VERSION = "PG18_ORDERED_AND_V1";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (v, expected) => v && same(Object.keys(v).sort(), [...expected].sort());
const ddl = (token, value) => token?.domain === "DDL_TOKEN" && token.value === value;
const identifier = (token) => {
  if (token?.domain !== "DDL_TOKEN") return null;
  const value = token.value;
  if (/^"(?:[^"]|"")+"$/u.test(value)) return value.slice(1, -1).replaceAll('""', '"');
  return /^[a-z_][a-z0-9_$]*$/u.test(value) ? value : null;
};
const flags = ["TYPE", "VALIDATION", "ENFORCEMENT", "INHERITANCE", "DEFERRABILITY", "PERIOD",
  "FK_ACTION", "PARENTAGE", "BINDING", "DEFINITION", "CHECK_EXPRESSION", "EXTENSION_OWNERSHIP"];

// Independently constrain the SQL excluded below. Parentheses disappear only
// around an AND node; leaves retain every token, including their parentheses.
const orderedSqlLeaves = (tokens, level = 0) => {
  if (!tokens.length || level > 64) throw new Error("SQL_GROUP_LIMIT");
  let depth = 0, outerClose = -1;
  const splits = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.domain === "DDL_TOKEN" && /^(?:OR|NOT|BETWEEN|CASE|WHEN|THEN|ELSE|END)$/iu.test(t.value)) throw new Error("SQL_UNSUPPORTED_BOOLEAN");
    if (ddl(t, "(")) depth += 1;
    if (ddl(t, ")")) {
      depth -= 1;
      if (depth < 0) throw new Error("SQL_GROUP_BOUNDARY");
      if (depth === 0 && outerClose < 0) outerClose = i;
    }
    if (depth > 64) throw new Error("SQL_GROUP_LIMIT");
    if (depth === 0 && ddl(t, "AND")) splits.push(i);
  }
  if (depth !== 0) throw new Error("SQL_GROUP_BOUNDARY");
  if (splits.length) {
    const leaves = [];
    let start = 0;
    for (const end of [...splits, tokens.length]) {
      leaves.push(...orderedSqlLeaves(tokens.slice(start, end), level + 1));
      start = end + 1;
    }
    return leaves;
  }
  if (ddl(tokens[0], "(") && outerClose === tokens.length - 1) {
    const inner = orderedSqlLeaves(tokens.slice(1, -1), level + 1);
    if (inner.length > 1) return inner;
  }
  if (tokens.some((t) => ddl(t, "AND"))) throw new Error("SQL_NESTED_NONCONJUNCTION");
  return [tokens];
};

const sqlLeaves = (check) => {
  const expression = tokenizeSchemaDump(check.expression);
  const definition = tokenizeSchemaDump(check.definition);
  if (!same(definition, [
    { domain: "DDL_TOKEN", value: "CHECK" }, { domain: "DDL_TOKEN", value: "(" },
    ...expression, { domain: "DDL_TOKEN", value: ")" },
  ])) throw new Error("SQL_EXPRESSION_BINDING");
  return orderedSqlLeaves(expression);
};

// Only remove the CHECK expression from its exact table/constraint declaration.
// All surrounding tokens (including flags) and every other statement remain.
const residual = (tokens, check) => {
  const [, schema, table, constraint] = check.identity;
  const definition = tokenizeSchemaDump(check.definition);
  if (!ddl(definition[0], "CHECK") || !ddl(definition[1], "(")) throw new Error("NOT_A_CHECK");
  let found = null, start = 0;
  for (let end = 0; end < tokens.length; end += 1) {
    if (!ddl(tokens[end], ";") && tokens[end].domain !== "META_COMMAND") continue;
    const statement = tokens.slice(start, end + 1);
    let relation = null, depthAtConstraint = null;
    if (ddl(statement[0], "CREATE") && ddl(statement[1], "TABLE")) { relation = 2; depthAtConstraint = 1; }
    if (ddl(statement[0], "ALTER") && ddl(statement[1], "TABLE")) {
      relation = ddl(statement[2], "ONLY") ? 3 : 2; depthAtConstraint = 0;
    }
    if (relation !== null && identifier(statement[relation]) === schema
      && ddl(statement[relation + 1], ".") && identifier(statement[relation + 2]) === table) {
      let depth = 0;
      for (let i = relation + 3; i < statement.length; i += 1) {
        if (ddl(statement[i], "(") ) depth += 1;
        if (ddl(statement[i], ")") ) depth -= 1;
        if (depth !== depthAtConstraint || !ddl(statement[i], "CONSTRAINT")
          || identifier(statement[i + 1]) !== constraint || !ddl(statement[i + 2], "CHECK")) continue;
        if (found !== null || !same(statement.slice(i + 2, i + 2 + definition.length), definition)) throw new Error("CHECK_BINDING_FAILED");
        let balance = 0, close = null;
        for (let j = 1; j < definition.length; j += 1) {
          if (ddl(definition[j], "(")) balance += 1;
          if (ddl(definition[j], ")") && --balance === 0) { close = j; break; }
        }
        if (close === null) throw new Error("CHECK_BOUNDARY_FAILED");
        found = [start + i + 3, start + i + 2 + close + 1];
      }
    }
    start = end + 1;
  }
  if (found === null) throw new Error("CHECK_DECLARATION_MISSING");
  return [...tokens.slice(0, found[0]), { domain: "DDL_TOKEN", value: "PROVEN_ORDERED_AND" }, ...tokens.slice(found[1])];
};

const manifestMap = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100000) throw new Error("BAD_MANIFEST");
  const map = new Map();
  for (const row of rows) {
    if (!keys(row, ["key", "type", "semantics"]) || typeof row.key !== "string"
      || !keys(row.semantics, flags) || map.has(row.key)) throw new Error("BAD_MANIFEST");
    map.set(row.key, row);
  }
  return map;
};

export function verifySchemaRepresentation(proof, sourceSchema, destinationSchema) {
  try {
    if (!keys(proof, ["version", "source", "destination"]) || proof.version !== REPRESENTATION_VERSION
      || Buffer.byteLength(JSON.stringify(proof)) > 24 * 1024 * 1024) return false;
    const a = proof.source, b = proof.destination;
    for (const side of [a, b]) {
      if (!keys(side, ["serverVersion", "tokens", "manifest", "check"])
        || !Number.isSafeInteger(side.serverVersion) || Math.floor(side.serverVersion / 10000) !== 18
        || !Array.isArray(side.tokens) || side.tokens.length > 1000000
        || side.tokens.some((t) => !keys(t, ["domain", "value"]))) return false;
    }
    if (a.serverVersion !== b.serverVersion || sourceSchema.algorithm !== "PG_DUMP_SQL_TOKENS_V1"
      || destinationSchema.algorithm !== sourceSchema.algorithm
      || schemaTokenDigest(a.tokens) !== sourceSchema.digest || schemaTokenDigest(b.tokens) !== destinationSchema.digest
      || sourceSchema.digest === destinationSchema.digest || !verifyBoundOrderedAnd(a.check, b.check)) return false;
    const left = manifestMap(a.manifest), right = manifestMap(b.manifest);
    if (!same([...left.keys()].sort(), [...right.keys()].sort())) return false;
    const candidate = JSON.stringify(a.check.identity);
    if (!left.has(candidate) || !right.has(candidate)) return false;
    for (const [key, row] of left) {
      const other = right.get(key);
      if (key !== candidate) { if (!same(row, other)) return false; continue; }
      if (row.type !== "CHECK" || other.type !== "CHECK") return false;
      for (const flag of flags.filter((v) => !["DEFINITION", "CHECK_EXPRESSION"].includes(v))) {
        if (!same(row.semantics[flag], other.semantics[flag])) return false;
      }
      if (row.semantics.TYPE !== "c" || !row.semantics.VALIDATION || !row.semantics.ENFORCEMENT
        || !same(row.semantics.INHERITANCE, [true, 0, false]) || row.semantics.PARENTAGE !== null
        || row.semantics.EXTENSION_OWNERSHIP !== null) return false;
      for (const [entry, check] of [[row, a.check], [other, b.check]]) {
        if (schemaTokenDigest(tokenizeSchemaDump(check.definition)) !== entry.semantics.DEFINITION
          || schemaTokenDigest(tokenizeSchemaDump(check.expression)) !== entry.semantics.CHECK_EXPRESSION) return false;
      }
    }
    return same(sqlLeaves(a.check), sqlLeaves(b.check))
      && same(residual(a.tokens, a.check), residual(b.tokens, b.check));
  } catch { return false; }
}

export function buildSchemaRepresentation(source, destination, sourceSchema, destinationSchema) {
  const proof = { version: REPRESENTATION_VERSION, source, destination };
  return verifySchemaRepresentation(proof, sourceSchema, destinationSchema) ? proof : null;
}
