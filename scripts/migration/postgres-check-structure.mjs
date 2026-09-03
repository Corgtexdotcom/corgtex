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
  return { canonical: JSON.stringify(canonical), original: JSON.stringify(root), nodes, flattened, refs };
};

// Explicit per-reference catalog bindings, including each type's I/O implementation.
// Builtin OIDs are retained in the tree as an additional conservative equality gate.
const bindingsSql = `
  WITH requested(kind, oid) AS (SELECT * FROM unnest($1::text[], $2::oid[])),
  bindings AS (
    SELECT r.kind, r.oid::text AS oid,
      CASE r.kind
        WHEN 'type' THEN (SELECT jsonb_build_array(n.nspname,t.typname,t.typtype,t.typlen,t.typbyval,
          t.typcategory,t.typcollation,ni.nspname,pi.proname,pi.prosrc,pi.probin,li.lanname,
          no.nspname,po.proname,po.prosrc,po.probin,lo.lanname)
          FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          JOIN pg_proc pi ON pi.oid=t.typinput JOIN pg_namespace ni ON ni.oid=pi.pronamespace
          JOIN pg_language li ON li.oid=pi.prolang
          JOIN pg_proc po ON po.oid=t.typoutput JOIN pg_namespace no ON no.oid=po.pronamespace
          JOIN pg_language lo ON lo.oid=po.prolang
          WHERE t.oid=r.oid AND n.nspname='pg_catalog' AND ni.nspname='pg_catalog' AND no.nspname='pg_catalog'
            AND pi.oid<16384 AND po.oid<16384 AND li.lanname='internal' AND lo.lanname='internal')
        WHEN 'operator' THEN (SELECT jsonb_build_array(n.nspname,o.oprname,o.oprkind,o.oprleft,o.oprright,o.oprresult,o.oprcode::oid)
          FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace
          WHERE o.oid=r.oid AND n.nspname='pg_catalog')
        WHEN 'function' THEN (SELECT jsonb_build_array(n.nspname,p.proname,p.proargtypes::text,p.prorettype,
          p.prosrc,p.probin,l.lanname,p.prokind,p.provolatile,p.proisstrict,p.proretset,p.prosecdef,p.proconfig)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
          WHERE p.oid=r.oid AND n.nspname='pg_catalog' AND l.lanname='internal')
        WHEN 'collation' THEN (SELECT jsonb_build_array(n.nspname,c.collname,c.collprovider,c.collisdeterministic,
          c.collencoding,c.collcollate,c.collctype,c.colllocale,c.collicurules,c.collversion,pg_collation_actual_version(c.oid))
          FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
          WHERE c.oid=r.oid AND n.nspname='pg_catalog')
        WHEN 'attribute' THEN (SELECT jsonb_build_array(n.nspname,t.relname,a.attname,a.atttypid,a.atttypmod,a.attcollation)
          FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE a.attrelid=$3::oid AND a.attnum=r.oid::int AND NOT a.attisdropped AND a.attnum>0)
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
    if (references.length > 256) reject("LIMIT_EXCEEDED");
    const bindings = await client.query(bindingsSql, [references.map((r) => r.kind), references.map((r) => r.oid), query.rows[0].relation_oid]);
    if (bindings.rows.length !== references.length || bindings.rows.some((row) => !Array.isArray(row.identity))) reject();
    if (Buffer.byteLength(JSON.stringify(bindings.rows), "utf8") > 65_536) reject("LIMIT_EXCEEDED");
    result = Object.freeze({ status: "CAPTURED" });
    privateCaptures.set(result, { ...prepared, bindings: JSON.stringify(bindings.rows) });
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
  const bindingsEqual = left.bindings === right.bindings;
  const canonicalEqual = left.canonical === right.canonical;
  const originalEqual = left.original === right.original;
  return {
    status: bindingsEqual && canonicalEqual && !originalEqual && left.flattened !== right.flattened
      ? "ASSOCIATIVE_GROUPING_ONLY" : "STRUCTURALLY_DIFFERENT",
    bindingsEqual, canonicalEqual, originalEqual,
    sourceNodes: left.nodes, destinationNodes: right.nodes,
    sourceFlattened: left.flattened, destinationFlattened: right.flattened,
  };
}
