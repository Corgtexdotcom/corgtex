// Diagnostic only: this module never changes schema-parity acceptance.
export const KNOWN_CHECK_KEY = JSON.stringify([
  "TABLE", "public", "ConstitutionSourceReference", "ConstitutionSource_point_contract_check",
]);
const privateCaptures = new WeakMap();
const fields = {
  BOOLEXPR: "boolop args location",
  VAR: "varno varattno vartype vartypmod varcollid varnullingrels varlevelsup varreturningtype varnosyn varattnosyn location",
  CONST: "consttype consttypmod constcollid constlen constbyval constisnull location constvalue",
  OPEXPR: "opno opfuncid opresulttype opretset opcollid inputcollid args location",
  COERCEVIAIO: "arg resulttype resultcollid coerceformat location",
};
class StructureError extends Error {
  constructor(status = "NOT_ELIGIBLE") { super(status); this.status = status; }
}
const reject = (status) => { throw new StructureError(status); };
const integer = (token) => typeof token === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(token)
  && Number.isSafeInteger(Number(token));

// Backslash escapes are kept byte-for-byte. They cannot introduce delimiters or fields.
const parse = (text) => {
  if (typeof text !== "string") reject();
  if (Buffer.byteLength(text, "utf8") > 262_144) reject("LIMIT_EXCEEDED");
  const tokens = [];
  for (let i = 0; i < text.length;) {
    if (/\s/u.test(text[i])) { i += 1; continue; }
    const start = i;
    if ("{}()[]".includes(text[i])) i += 1;
    else {
      while (i < text.length && !/\s/u.test(text[i]) && !"{}()[]".includes(text[i])) {
        if (text[i] === "\\") {
          i += 1;
          if (i === text.length) reject();
        }
        i += 1;
      }
    }
    tokens.push(text.slice(start, i));
    if (tokens.length > 65_536) reject("LIMIT_EXCEEDED");
  }
  let offset = 0;
  let nodes = 0;
  const value = (depth) => {
    if (depth > 64) reject("LIMIT_EXCEEDED");
    const token = tokens[offset++];
    if (token === undefined || ["}", ")", "]"].includes(token)) reject();
    if (token === "{") {
      if (++nodes > 4096) reject("LIMIT_EXCEEDED");
      const tag = tokens[offset++];
      if (!Object.hasOwn(fields, tag)) reject();
      const entries = [];
      const seen = new Set();
      while (tokens[offset] !== "}") {
        const key = tokens[offset++];
        if (typeof key !== "string" || !/^:[a-z]+$/u.test(key) || seen.has(key)) reject();
        seen.add(key);
        const values = [];
        while (tokens[offset] !== "}" && !tokens[offset]?.startsWith(":")) values.push(value(depth + 1));
        if (!values.length) reject();
        entries.push([key.slice(1), values]);
      }
      offset += 1;
      if (entries.map(([key]) => key).join(" ") !== fields[tag]) reject();
      return { tag, entries };
    }
    if (token === "(" || token === "[") {
      const close = token === "(" ? ")" : "]";
      const items = [];
      while (tokens[offset] !== close) items.push(value(depth + 1));
      offset += 1;
      return { list: token, items };
    }
    return token;
  };
  const root = value(0);
  if (offset !== tokens.length || root?.tag !== "BOOLEXPR") reject();
  return { root, nodes };
};

const prepare = (tree) => {
  const { root, nodes } = parse(tree);
  const refs = { type: new Set(), operator: new Set(), function: new Set(), collation: new Set(), attribute: new Set() };
  let flattened = 0;
  const visit = (node) => {
    if (!node?.tag) reject();
    const entries = new Map(node.entries);
    const one = (key) => {
      const values = entries.get(key);
      if (values?.length !== 1) reject();
      return values[0];
    };
    const scalar = (key) => {
      const result = one(key);
      if (typeof result !== "string") reject();
      return result;
    };
    const number = (key) => {
      const result = scalar(key);
      if (!integer(result)) reject();
      return Number(result);
    };
    const ref = (kind, key, zero = false) => {
      const result = number(key);
      if (zero && result === 0) return;
      // This diagnostic intentionally supports builtins only (and local attributes).
      if (result < 1 || result >= 16384) reject();
      refs[kind].add(result);
    };
    const args = () => {
      const result = one("args");
      if (result?.list !== "(") reject();
      return result.items;
    };
    if (number("location") < -1) reject();
    if (node.tag === "BOOLEXPR") {
      const op = scalar("boolop");
      const children = args();
      if (!["and", "or", "not"].includes(op) || (op === "not" ? children.length !== 1 : children.length < 2)) reject();
      const canonical = [];
      for (const child of children.map(visit)) {
        if (op !== "not" && child.boolop === op) {
          flattened += 1;
          canonical.push(...child.args);
        } else canonical.push(child);
      }
      return { boolop: op, args: canonical };
    }
    if (node.tag === "VAR") {
      for (const [key, expected] of Object.entries({ varno: 1, varlevelsup: 0, varreturningtype: 0, varnosyn: 1 })) {
        if (number(key) !== expected) reject();
      }
      if (number("varattno") !== number("varattnosyn") || number("vartypmod") !== -1) reject();
      if (JSON.stringify(one("varnullingrels")) !== JSON.stringify({ list: "(", items: ["b"] })) reject();
      ref("attribute", "varattno"); ref("type", "vartype"); ref("collation", "varcollid", true);
    } else if (node.tag === "CONST") {
      ref("type", "consttype"); ref("collation", "constcollid", true);
      number("consttypmod"); number("constlen");
      if (!["true", "false"].includes(scalar("constbyval")) || !["true", "false"].includes(scalar("constisnull"))) reject();
      const datum = entries.get("constvalue");
      if (scalar("constisnull") === "true") {
        if (datum.length !== 1 || datum[0] !== "<>") reject();
      } else if (datum.length !== 2 || !integer(datum[0]) || Number(datum[0]) < 0
        || datum[1]?.list !== "[" || !datum[1].items.every((byte) => integer(byte) && Number(byte) >= -128 && Number(byte) <= 255)) reject();
    } else if (node.tag === "OPEXPR") {
      ref("operator", "opno"); ref("function", "opfuncid"); ref("type", "opresulttype");
      ref("collation", "opcollid", true); ref("collation", "inputcollid", true);
      if (scalar("opretset") !== "false" || args().length !== 2) reject();
    } else if (node.tag === "COERCEVIAIO") {
      ref("type", "resulttype"); ref("collation", "resultcollid", true);
      if (number("coerceformat") !== 1) reject();
    }
    return { tag: node.tag, entries: node.entries.filter(([key]) => key !== "location").map(([key, values]) => [key,
      values.map((item) => item?.tag ? visit(item) : item?.list === "(" && key === "args"
        ? { list: "(", items: item.items.map(visit) } : item),
    ]) };
  };
  const canonical = visit(root);
  return { canonical: JSON.stringify(canonical), original: JSON.stringify(root), root, nodes, flattened, refs };
};

// This is also the complete public field vocabulary. Never derive output keys from catalog values.
const bindingFields = Object.fromEntries(Object.entries({
  type: "NAMESPACE:s NAME:s KIND:s LENGTH:n BY_VALUE:b CATEGORY:s COLLATION:n INPUT_NAMESPACE:s INPUT_NAME:s INPUT_SOURCE:s INPUT_BINARY:s? INPUT_LANGUAGE:s OUTPUT_NAMESPACE:s OUTPUT_NAME:s OUTPUT_SOURCE:s OUTPUT_BINARY:s? OUTPUT_LANGUAGE:s",
  operator: "NAMESPACE:s NAME:s KIND:s LEFT_TYPE:n RIGHT_TYPE:n RESULT_TYPE:n FUNCTION:n",
  function: "NAMESPACE:s NAME:s ARGUMENT_TYPES:s RESULT_TYPE:n SOURCE:s BINARY:s? LANGUAGE:s KIND:s VOLATILITY:s STRICT:b RETURNS_SET:b SECURITY_DEFINER:b CONFIG:a?",
  collation: "NAMESPACE:s NAME:s PROVIDER:s DETERMINISTIC:b ENCODING:n COLLATE:s? CTYPE:s? LOCALE:s? ICU_RULES:s? VERSION:s? ACTUAL_VERSION:s?",
  attribute: "NAMESPACE:s TABLE:s NAME:s TYPE:n TYPMOD:n COLLATION:n",
  database_collation: "ENCODING:s PROVIDER:s COLLATE:s CTYPE:s LOCALE:s? ICU_RULES:s? VERSION:s? ACTUAL_VERSION:s?",
}).map(([kind, schema]) => [kind, schema.split(" ").map((field) => field.split(":"))]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const versionField = (kind, name) => ["collation", "database_collation"].includes(kind)
  && ["VERSION", "ACTUAL_VERSION"].includes(name);
const validateBindings = (rows, references) => {
  if (!Array.isArray(rows) || rows.length !== references.length) reject();
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 65_536) reject("LIMIT_EXCEEDED");
  const requested = new Set(references.map(({ kind, oid }) => `${kind}:${oid}`));
  const bindings = new Map();
  for (const row of rows) {
    const key = `${row.kind}:${row.oid}`;
    if (!same(Object.keys(row).sort(), ["identity", "kind", "oid"]) || !requested.has(key)
      || bindings.has(key) || typeof row.oid !== "string" || !/^\d+$/u.test(row.oid)) reject();
    const schema = bindingFields[row.kind];
    if (!Array.isArray(row.identity) || row.identity.length !== schema.length) reject();
    for (let i = 0; i < schema.length; i += 1) {
      const type = schema[i][1];
      const value = row.identity[i];
      if (value === null && type.endsWith("?")) continue;
      const string = (v) => typeof v === "string" && Buffer.byteLength(v, "utf8") <= 4096;
      if (!(type.startsWith("s") ? string(value) : type === "n" ? Number.isSafeInteger(value)
        : type === "b" ? typeof value === "boolean"
          : Array.isArray(value) && value.length <= 64 && value.every(string))) reject();
    }
    // Copy so a client's row buffers cannot change a completed private capture.
    bindings.set(key, structuredClone(row.identity));
  }
  return bindings;
};

const compareBindings = (left, right) => {
  const classes = {};
  let referenceSetsEqual = true;
  let differences = 0;
  let nonVersionDifferences = 0;
  for (const [kind, schema] of Object.entries(bindingFields)) {
    const counts = { missing: 0, extra: 0, changed: 0, fields: Object.fromEntries(schema.map(([name]) => [name, 0])) };
    const keys = new Set([...left.keys(), ...right.keys()].filter((key) => key.startsWith(`${kind}:`)));
    for (const key of keys) {
      const a = left.get(key);
      const b = right.get(key);
      if (!a || !b) {
        counts[a ? "missing" : "extra"] += 1;
        referenceSetsEqual = false;
        continue;
      }
      let changed = false;
      schema.forEach(([name], i) => {
        if (same(a[i], b[i])) return;
        counts.fields[name] += 1;
        differences += 1;
        if (!versionField(kind, name)) nonVersionDifferences += 1;
        changed = true;
      });
      if (changed) counts.changed += 1;
    }
    classes[kind.toUpperCase()] = counts;
  }
  return {
    classes, referenceSetsEqual,
    bindingsEqual: referenceSetsEqual && differences === 0,
    nonVersionBindingsEqual: referenceSetsEqual && nonVersionDifferences === 0,
    collationVersionOnly: referenceSetsEqual && differences > 0 && nonVersionDifferences === 0,
  };
};

// Narrow PG18 builtin vocabulary, not a general SQL-equivalence engine. The type
// I/O bindings cover the only admitted coercion (int4out -> textin).
const supportedTypes = new Map([
  [16, ["bool", 1, true, "B", 0, "boolin", "boolout"]],
  [23, ["int4", 4, true, "N", 0, "int4in", "int4out"]],
  [25, ["text", -1, false, "S", 100, "textin", "textout"]],
]);
const supportedOperators = new Map([
  [525, [">=", 23, 16, 150, "int4ge"]],
  [523, ["<=", 23, 16, 149, "int4le"]],
  [98, ["=", 25, 16, 67, "texteq"]],
  [654, ["||", 25, 25, 1258, "textcat"]],
]);
const supportedOperations = ({ root, bindings }) => {
  const bound = (kind, oid, expected) => same(bindings.get(`${kind}:${oid}`), expected);
  for (const [oid, [name, length, byValue, category, collation, input, output]] of supportedTypes) {
    if (!bound("type", oid, ["pg_catalog", name, "b", length, byValue, category, collation,
      "pg_catalog", input, input, null, "internal", "pg_catalog", output, output, null, "internal"])) return false;
  }
  for (const [oid, [name, input, output, fn, source]] of supportedOperators) {
    if (!bound("operator", oid, ["pg_catalog", name, "b", input, input, output, fn])
      || !bound("function", fn, ["pg_catalog", source, `${input} ${input}`, output, source, null,
        "internal", "f", "i", true, false, false, null])) return false;
  }
  const visit = (node) => {
    const entries = new Map(node.entries);
    const one = (key) => entries.get(key)?.[0];
    const n = (key) => Number(one(key));
    if (node.tag === "BOOLEXPR") {
      return one("boolop") === "and" && one("args").items.every((child) => visit(child) === 16) ? 16 : null;
    }
    if (node.tag === "VAR") {
      const type = n("vartype");
      const collation = type === 25 ? 100 : 0;
      const attr = bindings.get(`attribute:${n("varattno")}`);
      return [23, 25].includes(type) && n("varcollid") === collation && attr?.[0] === "public"
        && attr[1] === "ConstitutionSourceReference" && same(attr.slice(3), [type, -1, collation]) ? type : null;
    }
    if (node.tag === "CONST") {
      const type = n("consttype");
      const expected = supportedTypes.get(type);
      return [23, 25].includes(type) && n("constcollid") === expected[4]
        && n("consttypmod") === -1 && n("constlen") === expected[1]
        && one("constbyval") === String(expected[2]) ? type : null;
    }
    if (node.tag === "COERCEVIAIO") {
      return n("resulttype") === 25 && n("resultcollid") === 100 && visit(one("arg")) === 23 ? 25 : null;
    }
    if (node.tag === "OPEXPR") {
      const op = supportedOperators.get(n("opno"));
      if (!op) return null;
      const [, input, output, fn] = op;
      return n("opfuncid") === fn && n("opresulttype") === output
        && n("opcollid") === (output === 25 ? 100 : 0) && n("inputcollid") === (input === 25 ? 100 : 0)
        && one("args").items.every((child) => visit(child) === input) ? output : null;
    }
    return null;
  };
  return visit(root) === 16;
};

const currentDefaultLibc = ({ bindings, refs }) => {
  if (!same([...refs.collation], [100])) return false;
  const db = bindings.get("database_collation:0");
  const collation = bindings.get("collation:100");
  return db[0] === "UTF8" && db[1] === "c" && db[2].length > 0 && db[3].length > 0
    && db[4] === null && db[5] === null && typeof db[6] === "string" && db[6].length > 0 && db[6] === db[7]
    && same(collation, ["pg_catalog", "default", "d", true, -1, null, null, null, null, null, db[7]]);
};

// Explicit per-reference catalog bindings, including each type's I/O implementation.
// Builtin OIDs are retained in the tree as an additional conservative equality gate.
const bindingsSql = `
  WITH requested(kind, oid) AS (SELECT * FROM unnest($1::text[], $2::oid[])),
  bindings AS (
    SELECT r.kind, r.oid::text AS oid,
      CASE r.kind
        WHEN 'type' THEN (SELECT jsonb_build_array(n.nspname,t.typname,t.typtype,t.typlen,t.typbyval,
          t.typcategory,t.typcollation::bigint,ni.nspname,pi.proname,pi.prosrc,pi.probin,li.lanname,
          no.nspname,po.proname,po.prosrc,po.probin,lo.lanname)
          FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          JOIN pg_proc pi ON pi.oid=t.typinput JOIN pg_namespace ni ON ni.oid=pi.pronamespace
          JOIN pg_language li ON li.oid=pi.prolang
          JOIN pg_proc po ON po.oid=t.typoutput JOIN pg_namespace no ON no.oid=po.pronamespace
          JOIN pg_language lo ON lo.oid=po.prolang
          WHERE t.oid=r.oid AND n.nspname='pg_catalog' AND ni.nspname='pg_catalog' AND no.nspname='pg_catalog'
            AND pi.oid<16384 AND po.oid<16384 AND li.lanname='internal' AND lo.lanname='internal')
        WHEN 'operator' THEN (SELECT jsonb_build_array(n.nspname,o.oprname,o.oprkind,
          o.oprleft::bigint,o.oprright::bigint,o.oprresult::bigint,o.oprcode::oid::bigint)
          FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace
          WHERE o.oid=r.oid AND n.nspname='pg_catalog')
        WHEN 'function' THEN (SELECT jsonb_build_array(n.nspname,p.proname,p.proargtypes::text,p.prorettype::bigint,
          p.prosrc,p.probin,l.lanname,p.prokind,p.provolatile,p.proisstrict,p.proretset,p.prosecdef,p.proconfig)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
          WHERE p.oid=r.oid AND n.nspname='pg_catalog' AND l.lanname='internal')
        WHEN 'collation' THEN (SELECT jsonb_build_array(n.nspname,c.collname,c.collprovider,c.collisdeterministic,
          c.collencoding,c.collcollate,c.collctype,c.colllocale,c.collicurules,c.collversion,pg_collation_actual_version(c.oid))
          FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
          WHERE c.oid=r.oid AND n.nspname='pg_catalog')
        WHEN 'attribute' THEN (SELECT jsonb_build_array(n.nspname,t.relname,a.attname,a.atttypid::bigint,a.atttypmod,a.attcollation::bigint)
          FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE a.attrelid=$3::oid AND a.attnum=r.oid::int AND NOT a.attisdropped AND a.attnum>0)
        WHEN 'database_collation' THEN (SELECT jsonb_build_array(pg_encoding_to_char(d.encoding),d.datlocprovider,
          d.datcollate,d.datctype,d.datlocale,d.daticurules,d.datcollversion,pg_database_collation_actual_version(d.oid))
          FROM pg_database d WHERE d.datname=current_database())
      END AS identity FROM requested r
  ) SELECT kind,oid,CASE WHEN octet_length(identity::text)<=4096 THEN identity END AS identity
    FROM bindings ORDER BY kind COLLATE "C", oid::bigint
`;

export async function captureKnownCheckStructure(client, entry) {
  if (entry?.key !== KNOWN_CHECK_KEY || entry.type !== "CHECK"
    || !/^[1-9][0-9]{0,9}$/u.test(entry?.diagnostic?.constraintOid)) return { status: "NOT_ELIGIBLE" };
  // Caller must own a transaction. Rolling back this read-only savepoint also restores timeouts.
  try { await client.query("SAVEPOINT corgtex_check_structure"); }
  catch { throw new Error("CHECK_STRUCTURE_SAVEPOINT_FAILED"); }
  let result;
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    const boundary = await client.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout");
    if (boundary.rows[0]?.ro !== "on" || boundary.rows[0]?.timeout !== "15s") reject("UNAVAILABLE");
    const query = await client.query(`
      SELECT c.conrelid::text AS relation_oid, octet_length(c.conbin::text) AS bytes,
        CASE WHEN octet_length(c.conbin::text)<=262144 THEN c.conbin::text END AS tree
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE c.oid=$1::oid AND c.contype='c' AND n.nspname='public'
        AND t.relname='ConstitutionSourceReference' AND c.conname='ConstitutionSource_point_contract_check'
        AND c.connamespace=n.oid AND t.relkind='r' AND t.relpersistence='p' AND NOT t.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
    `, [entry.diagnostic.constraintOid]);
    if (query.rows.length !== 1) reject();
    if (query.rows[0].bytes > 262_144) reject("LIMIT_EXCEEDED");
    const prepared = prepare(query.rows[0].tree);
    const references = Object.entries(prepared.refs).flatMap(([kind, ids]) => [...ids].map((oid) => ({ kind, oid })));
    // Captured inside the caller's same read-only snapshot, never a later reconnect.
    references.push({ kind: "database_collation", oid: 0 });
    if (references.length > 256) reject("LIMIT_EXCEEDED");
    const bindings = await client.query(bindingsSql, [references.map((r) => r.kind), references.map((r) => r.oid), query.rows[0].relation_oid]);
    const validatedBindings = validateBindings(bindings.rows, references);
    result = Object.freeze({ status: "CAPTURED" });
    privateCaptures.set(result, { ...prepared, bindings: validatedBindings });
  } catch (error) {
    result = { status: error instanceof StructureError ? error.status : "UNAVAILABLE" };
  } finally {
    try {
      await client.query("ROLLBACK TO SAVEPOINT corgtex_check_structure");
      await client.query("RELEASE SAVEPOINT corgtex_check_structure");
    } catch { throw new Error("CHECK_STRUCTURE_SAVEPOINT_FAILED"); }
  }
  return result;
}

export function compareKnownCheckStructure(source, destination, candidate, serverVersionRelation) {
  const status = (value) => ({ status: value });
  if (serverVersionRelation !== "MATCH" || candidate?.source?.key !== KNOWN_CHECK_KEY
    || candidate?.destination?.key !== KNOWN_CHECK_KEY) return status("NOT_ELIGIBLE");
  const a = candidate.source.semantics;
  const b = candidate.destination.semantics;
  if (!a || !b || Object.keys(a).sort().join() !== Object.keys(b).sort().join()) return status("NOT_ELIGIBLE");
  const changed = Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
  if (JSON.stringify(changed) !== JSON.stringify(["CHECK_EXPRESSION", "DEFINITION"])) return status("NOT_ELIGIBLE");
  const left = privateCaptures.get(source);
  const right = privateCaptures.get(destination);
  if (!left || !right) {
    return status([source?.status, destination?.status].includes("LIMIT_EXCEEDED") ? "LIMIT_EXCEEDED"
      : [source?.status, destination?.status].includes("NOT_ELIGIBLE") ? "NOT_ELIGIBLE" : "UNAVAILABLE");
  }
  const comparison = compareBindings(left.bindings, right.bindings);
  const { bindingsEqual, nonVersionBindingsEqual, collationVersionOnly, referenceSetsEqual } = comparison;
  const canonicalEqual = left.canonical === right.canonical;
  const originalEqual = left.original === right.original;
  const groupingShape = canonicalEqual && !originalEqual && left.flattened !== right.flattened;
  const operationsSupported = supportedOperations(left) && supportedOperations(right);
  const defaultCollationCurrentLibc = currentDefaultLibc(left) && currentDefaultLibc(right);
  return {
    status: bindingsEqual && groupingShape
      ? "ASSOCIATIVE_GROUPING_ONLY" : "STRUCTURALLY_DIFFERENT",
    bindingsEqual, canonicalEqual, originalEqual,
    bindingDifferences: comparison.classes, referenceSetsEqual, nonVersionBindingsEqual, collationVersionOnly,
    operationsSupported, defaultCollationCurrentLibc,
    versionDriftAssessment: collationVersionOnly && groupingShape && operationsSupported && defaultCollationCurrentLibc
      ? "VERSION_DRIFT_IRRELEVANT_TO_SUPPORTED_CHECK" : "UNPROVEN",
    sourceNodes: left.nodes, destinationNodes: right.nodes,
    sourceFlattened: left.flattened, destinationFlattened: right.flattened,
  };
}
