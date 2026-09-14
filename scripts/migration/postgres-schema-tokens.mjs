import { createHash } from "node:crypto";
export const SCHEMA_RESTRICT_KEY = "CorgtexSchemaParityV1";

const SCHEMA_TOKEN_DOMAINS = ["DDL_TOKEN", "STRING_LITERAL", "DOLLAR_BODY", "META_COMMAND"];

export class SchemaTokenError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const schemaFail = (code) => { throw new SchemaTokenError(code); };
const isSchemaWhitespace = (character) => character === " "
  || character === "\t"
  || character === "\r"
  || character === "\n"
  || character === "\f";
export const isSchemaOperator = (character) => /[~!@#%^&|`?+*/<>=:-]/u.test(character);
const isSchemaPunctuation = (character) => /[()[\]{},.;]/u.test(character);

const readQuotedSchemaToken = (content, start, quote, backslashEscapes, code) => {
  let index = start + 1;
  while (index < content.length) {
    if (backslashEscapes && content[index] === "\\") {
      if (index + 1 >= content.length) schemaFail(code);
      index += 2;
      continue;
    }
    if (content[index] === quote) {
      if (content[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  schemaFail(code);
};

export const tokenizeSchemaDump = (content) => {
  if (typeof content !== "string" || content.length === 0 || content.includes("\u0000")) {
    schemaFail("INVALID_SCHEMA_DUMP");
  }
  const tokens = [];
  const push = (domain, value) => tokens.push({ domain, value });
  let index = 0;
  let lineOnlyWhitespace = true;
  while (index < content.length) {
    const character = content[index];
    if (isSchemaWhitespace(character)) {
      if (character === "\n" || character === "\r") lineOnlyWhitespace = true;
      index += 1;
      continue;
    }
    if (content.startsWith("--", index)) {
      const newline = content.indexOf("\n", index + 2);
      index = newline === -1 ? content.length : newline + 1;
      lineOnlyWhitespace = true;
      continue;
    }
    if (content.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < content.length && depth > 0) {
        if (content.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (content.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          if (content[index] === "\n" || content[index] === "\r") lineOnlyWhitespace = true;
          index += 1;
        }
      }
      if (depth !== 0) schemaFail("UNTERMINATED_SCHEMA_COMMENT");
      continue;
    }
    if (character === "\\") {
      if (!lineOnlyWhitespace) schemaFail("UNEXPECTED_SCHEMA_META_COMMAND");
      const newline = content.indexOf("\n", index);
      const end = newline === -1 ? content.length : newline;
      const command = content.slice(index, end).replace(/\r$/u, "");
      if (!new Set([
        `\\restrict ${SCHEMA_RESTRICT_KEY}`,
        `\\unrestrict ${SCHEMA_RESTRICT_KEY}`,
      ]).has(command)) schemaFail("UNEXPECTED_SCHEMA_META_COMMAND");
      push("META_COMMAND", command);
      index = newline === -1 ? content.length : newline + 1;
      lineOnlyWhitespace = true;
      continue;
    }
    lineOnlyWhitespace = false;

    const unicodePrefix = content.slice(index, index + 3).toUpperCase();
    if (unicodePrefix === "U&'" || unicodePrefix === 'U&"') {
      const quote = content[index + 2];
      const end = readQuotedSchemaToken(content, index + 2, quote, quote === "'", "UNTERMINATED_SCHEMA_QUOTE");
      push(quote === "'" ? "STRING_LITERAL" : "DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (/[EBXN]/iu.test(character) && content[index + 1] === "'") {
      const end = readQuotedSchemaToken(
        content,
        index + 1,
        "'",
        character.toUpperCase() === "E",
        "UNTERMINATED_SCHEMA_STRING",
      );
      push("STRING_LITERAL", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === "'") {
      const end = readQuotedSchemaToken(content, index, "'", false, "UNTERMINATED_SCHEMA_STRING");
      push("STRING_LITERAL", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === '"') {
      const end = readQuotedSchemaToken(content, index, '"', false, "UNTERMINATED_SCHEMA_IDENTIFIER");
      push("DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === "$") {
      const delimiterMatch = content.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
      if (delimiterMatch !== null) {
        const delimiter = delimiterMatch[0];
        const endStart = content.indexOf(delimiter, index + delimiter.length);
        if (endStart === -1) schemaFail("UNTERMINATED_SCHEMA_DOLLAR_BODY");
        const end = endStart + delimiter.length;
        push("DOLLAR_BODY", content.slice(index, end));
        index = end;
        continue;
      }
    }
    if (isSchemaOperator(character)) {
      let end = index + 1;
      while (end < content.length && isSchemaOperator(content[end])) {
        if (content.startsWith("--", end) || content.startsWith("/*", end)) break;
        end += 1;
      }
      push("DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (isSchemaPunctuation(character)) {
      push("DDL_TOKEN", character);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < content.length) {
      const next = content[end];
      if (
        isSchemaWhitespace(next)
        || next === "'"
        || next === '"'
        || next === "\\"
        || next === "$"
        || isSchemaOperator(next)
        || isSchemaPunctuation(next)
        || content.startsWith("--", end)
        || content.startsWith("/*", end)
      ) break;
      end += 1;
    }
    push("DDL_TOKEN", content.slice(index, end));
    index = end;
  }
  if (tokens.length === 0) schemaFail("EMPTY_SCHEMA_TOKEN_STREAM");
  return tokens;
};

const updateLengthFramed = (hash, value) => {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
};

export const schemaTokenDigest = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) schemaFail("EMPTY_SCHEMA_TOKEN_STREAM");
  const hash = createHash("sha256");
  for (const token of tokens) {
    if (!SCHEMA_TOKEN_DOMAINS.includes(token?.domain) || typeof token.value !== "string" || token.value.length === 0) {
      schemaFail("INVALID_SCHEMA_TOKEN");
    }
    updateLengthFramed(hash, token.domain);
    updateLengthFramed(hash, token.value);
  }
  return hash.digest("hex");
};
