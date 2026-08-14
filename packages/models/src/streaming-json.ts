export type IncrementalJsonStringResult = {
  delta: string;
  state: "incomplete" | "complete" | "malformed";
};

type ScanResult = {
  state: IncrementalJsonStringResult["state"];
  value: string;
  next: number;
};

function incomplete(value = "", next = 0): ScanResult {
  return { state: "incomplete", value, next };
}

function malformed(value = "", next = 0): ScanResult {
  return { state: "malformed", value, next };
}

function scanString(input: string, start: number): ScanResult {
  if (input[start] !== "\"") return malformed("", start);
  let value = "";
  let index = start + 1;
  const escapes: Record<string, string> = {
    "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
  };
  while (index < input.length) {
    const character = input[index]!;
    if (character === "\"") return { state: "complete", value, next: index + 1 };
    if (character.charCodeAt(0) < 0x20) return malformed(value, index);
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    if (index + 1 >= input.length) return incomplete(value, index);
    const escaped = input[index + 1]!;
    if (escaped !== "u") {
      if (!(escaped in escapes)) return malformed(value, index);
      value += escapes[escaped];
      index += 2;
      continue;
    }
    if (index + 6 > input.length) return incomplete(value, index);
    const hex = input.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return malformed(value, index);
    const unit = Number.parseInt(hex, 16);
    index += 6;
    if (unit >= 0xd800 && unit <= 0xdbff && index >= input.length) return incomplete(value, index);
    if (unit >= 0xd800 && unit <= 0xdbff && input[index] === "\\" && index + 1 >= input.length) return incomplete(value, index);
    if (unit >= 0xd800 && unit <= 0xdbff && input.slice(index, index + 2) === "\\u") {
      if (index + 6 > input.length) return incomplete(value, index);
      const lowHex = input.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) return malformed(value, index);
      const low = Number.parseInt(lowHex, 16);
      if (low >= 0xdc00 && low <= 0xdfff) {
        value += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00);
        index += 6;
        continue;
      }
    }
    value += String.fromCharCode(unit);
  }
  return incomplete(value, index);
}

function skipWhitespace(input: string, start: number) {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  return index;
}

function skipValue(input: string, start: number): ScanResult {
  const index = skipWhitespace(input, start);
  if (index >= input.length) return incomplete("", index);
  if (input[index] === "\"") return scanString(input, index);
  if (input[index] === "{" || input[index] === "[") {
    const stack = [input[index] === "{" ? "}" : "]"];
    let cursor = index + 1;
    while (cursor < input.length) {
      const character = input[cursor]!;
      if (character === "\"") {
        const string = scanString(input, cursor);
        if (string.state !== "complete") return string;
        cursor = string.next;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
      else if (character === "}" || character === "]") {
        if (stack.pop() !== character) return malformed("", cursor);
        if (stack.length === 0) return { state: "complete", value: "", next: cursor + 1 };
      }
      cursor += 1;
    }
    return incomplete("", cursor);
  }
  let cursor = index;
  while (cursor < input.length && !/[\s,}]/.test(input[cursor]!)) cursor += 1;
  if (cursor === index) return malformed("", cursor);
  if (cursor === input.length) return incomplete("", cursor);
  try {
    JSON.parse(input.slice(index, cursor));
    return { state: "complete", value: "", next: cursor };
  } catch {
    return malformed("", index);
  }
}

function findStringField(input: string, field: string): ScanResult {
  let index = skipWhitespace(input, 0);
  if (index >= input.length) return incomplete();
  if (input[index] !== "{") return malformed();
  index += 1;
  while (true) {
    index = skipWhitespace(input, index);
    if (index >= input.length) return incomplete();
    if (input[index] === "}") return malformed();
    const key = scanString(input, index);
    if (key.state !== "complete") return { ...key, value: "" };
    index = skipWhitespace(input, key.next);
    if (index >= input.length) return incomplete();
    if (input[index] !== ":") return malformed();
    index = skipWhitespace(input, index + 1);
    if (index >= input.length) return incomplete();
    if (key.value === field) return scanString(input, index);
    const value = skipValue(input, index);
    if (value.state !== "complete") return { ...value, value: "" };
    index = skipWhitespace(input, value.next);
    if (index >= input.length) return incomplete();
    if (input[index] === ",") {
      index += 1;
      continue;
    }
    if (input[index] === "}") return malformed();
    return malformed();
  }
}

export class IncrementalJsonStringDecoder {
  private input = "";
  private emitted = "";
  private failed = false;

  constructor(private readonly field: string) {
    if (!field) throw new Error("JSON string field is required.");
  }

  push(fragment: string): IncrementalJsonStringResult {
    if (this.failed) return { delta: "", state: "malformed" };
    this.input += fragment;
    const result = findStringField(this.input, this.field);
    if (result.state === "malformed" || !result.value.startsWith(this.emitted)) {
      this.failed = true;
      return { delta: "", state: "malformed" };
    }
    const delta = result.value.slice(this.emitted.length);
    this.emitted = result.value;
    return { delta, state: result.state };
  }

  finish(): IncrementalJsonStringResult {
    if (this.failed) return { delta: "", state: "malformed" };
    const scanned = findStringField(this.input, this.field);
    if (scanned.state !== "complete") return { delta: "", state: scanned.state };
    try {
      const parsed = JSON.parse(this.input) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || parsed[this.field] !== this.emitted) throw new Error();
      return { delta: "", state: "complete" };
    } catch {
      return { delta: "", state: "malformed" };
    }
  }
}
