export type IncrementalJsonStringResult = { delta: string; state: "incomplete" | "complete" | "malformed" };
type Phase = "start" | "key" | "colon" | "value" | "comma" | "done"; type StringRole = "key" | "target" | "skip";
const ESCAPES: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const whitespace = (value: string) => " \n\r\t".includes(value); const hex = (value: string) => /^[0-9a-f]$/i.test(value);
function jsonPrefixState(input: string): "incomplete" | "complete" | "malformed" {
  let index = 0; const abort = (state: "incomplete" | "malformed"): never => { throw state; }; const skip = () => { while (index < input.length && whitespace(input[index]!)) index += 1; }; const take = () => { if (index >= input.length) abort("incomplete"); return input[index++]!; };
  const string = () => { if (take() !== "\"") abort("malformed"); while (true) { const character = take(); if (character === "\"") return; if (character === "\\") { const escape = take(); if (escape === "u") { for (let count = 0; count < 4; count += 1) if (!hex(take())) abort("malformed"); } else if (!(escape in ESCAPES)) abort("malformed"); } else if (character.charCodeAt(0) < 0x20) abort("malformed"); } };
  const literal = (expected: string) => { for (const character of expected) if (take() !== character) abort("malformed"); };
  const number = () => { const start = index; while (index < input.length && /[0-9eE+.\-]/.test(input[index]!)) index += 1; const token = input.slice(start, index); const complete = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token); const viable = /^-?$|^-?(?:0|[1-9]\d*)$|^-?(?:0|[1-9]\d*)\.\d*$|^-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?\d*$/.test(token); if (!complete) { if (index === input.length && viable) abort("incomplete"); abort("malformed"); } };
  function value() { skip(); if (index >= input.length) abort("incomplete"); const character = input[index]!; if (character === "\"") string(); else if (character === "{") object(); else if (character === "[") array(); else if (character === "t") literal("true"); else if (character === "f") literal("false"); else if (character === "n") literal("null"); else if (character === "-" || /\d/.test(character)) number(); else abort("malformed"); }
  function object() { index += 1; skip(); if (index >= input.length) abort("incomplete"); if (input[index] === "}") { index += 1; return; } while (true) { string(); skip(); if (take() !== ":") abort("malformed"); value(); skip(); const delimiter = take(); if (delimiter === "}") return; if (delimiter !== ",") abort("malformed"); skip(); } }
  function array() { index += 1; skip(); if (index >= input.length) abort("incomplete"); if (input[index] === "]") { index += 1; return; } while (true) { value(); skip(); const delimiter = take(); if (delimiter === "]") return; if (delimiter !== ",") abort("malformed"); skip(); } }
  try { value(); skip(); if (index !== input.length) abort("malformed"); return "complete"; } catch (state) { return state === "incomplete" ? "incomplete" : "malformed"; }
}
export class IncrementalJsonStringDecoder {
  private fragments: string[] = []; private phase: Phase = "start"; private role: StringRole | null = null;
  private text = ""; private currentKey = ""; private targetValue = "";
  private targetComplete = false; private escaped = false; private failed = false;
  private unicode: string | null = null; private high: number | null = null;
  private stack: string[] = []; private primitive: string | null = null;
  private nestedString = false; private nestedEscape = false; private nestedUnicode = 0;
  private delta = ""; private work = 0;
  constructor(private readonly field: string) { if (!field) throw new Error("JSON string field is required."); }
  get processedCharacters() { return this.work; } private fail() { this.failed = true; }
  private emit(value: string) {
    if (this.role === "key") this.text += value;
    if (this.role === "target") { this.targetValue += value; this.delta += value; } }
  private flushHigh() { if (this.high !== null) this.fail(); this.high = null; }
  private emitUnit(unit: number) {
    if (this.high !== null && unit >= 0xdc00 && unit <= 0xdfff) { this.emit(String.fromCodePoint(0x10000 + ((this.high - 0xd800) << 10) + unit - 0xdc00)); this.high = null; return; }
    this.flushHigh();
    if (unit >= 0xd800 && unit <= 0xdbff) this.high = unit;
    else if (unit >= 0xdc00 && unit <= 0xdfff) this.fail(); else this.emit(String.fromCharCode(unit));
  }
  private closeString() {
    this.flushHigh();
    if (this.role === "key") { this.currentKey = this.text; this.phase = "colon"; }
    else { if (this.role === "target") this.targetComplete = true; this.phase = "comma"; }
    this.role = null;
  }
  private scanString(character: string) {
    if (this.unicode !== null) {
      if (!hex(character)) return this.fail();
      this.unicode += character;
      if (this.unicode.length === 4) { this.emitUnit(Number.parseInt(this.unicode, 16)); this.unicode = null; }
    } else if (this.escaped) {
      this.escaped = false;
      if (character === "u") this.unicode = "";
      else if (character in ESCAPES) { this.flushHigh(); this.emit(ESCAPES[character]!); }
      else this.fail();
    } else if (character === "\\") this.escaped = true;
    else if (character === "\"") this.closeString();
    else if (character.charCodeAt(0) < 0x20) this.fail();
    else this.emitUnit(character.charCodeAt(0));
  }
  private scanNested(character: string) {
    if (this.nestedUnicode > 0) {
      if (!hex(character)) this.fail(); else this.nestedUnicode -= 1;
    } else if (this.nestedEscape) {
      this.nestedEscape = false;
      if (character === "u") this.nestedUnicode = 4; else if (!(character in ESCAPES)) this.fail();
    } else if (this.nestedString) {
      if (character === "\\") this.nestedEscape = true;
      else if (character === "\"") this.nestedString = false;
      else if (character.charCodeAt(0) < 0x20) this.fail();
    } else if (character === "\"") this.nestedString = true;
    else if (character === "{" || character === "[") this.stack.push(character === "{" ? "}" : "]");
    else if (character === "}" || character === "]") { if (this.stack.pop() !== character) this.fail(); else if (this.stack.length === 0) this.phase = "comma"; }
  }
  private beginValue(character: string) {
    if (this.currentKey === this.field) { if (this.targetComplete || character !== "\"") this.fail(); else this.role = "target"; }
    else if (character === "\"") this.role = "skip";
    else if (character === "{" || character === "[") this.stack.push(character === "{" ? "}" : "]");
    else this.primitive = character;
  }
  push(fragment: string): IncrementalJsonStringResult {
    if (this.failed) return { delta: "", state: "malformed" };
    this.fragments.push(fragment); this.delta = "";
    for (let index = 0; index < fragment.length && !this.failed;) {
      const character = fragment[index]!; this.work += 1;
      if (this.role) this.scanString(character);
      else if (this.stack.length > 0) this.scanNested(character);
      else if (this.primitive !== null) {
        if (whitespace(character) || character === "," || character === "}") {
          try { JSON.parse(this.primitive); } catch { this.fail(); }
          this.primitive = null; this.phase = "comma"; continue;
        }
        if (character === "]" || character === "{" || character === "[") this.fail(); else this.primitive += character;
      } else if (!whitespace(character)) {
        if (this.phase === "start") { if (character !== "{") this.fail(); else this.phase = "key"; }
        else if (this.phase === "key") { if (character !== "\"") this.fail(); else { this.role = "key"; this.text = ""; } }
        else if (this.phase === "colon") { if (character !== ":") this.fail(); else this.phase = "value"; }
        else if (this.phase === "value") this.beginValue(character);
        else if (this.phase === "comma") { if (character === ",") this.phase = "key"; else if (character === "}") this.phase = "done"; else this.fail(); }
        else this.fail();
      }
      index += 1;
    }
    return this.failed ? { delta: "", state: "malformed" } : { delta: this.delta, state: this.targetComplete ? "complete" : "incomplete" };
  }
  finish(): IncrementalJsonStringResult { if (this.failed) return { delta: "", state: "malformed" };
    if (!this.targetComplete) return { delta: "", state: this.phase === "done" ? "malformed" : "incomplete" }; const terminal = jsonPrefixState(this.fragments.join("")); return { delta: "", state: terminal === "complete" && this.phase !== "done" ? "malformed" : terminal }; }
}
