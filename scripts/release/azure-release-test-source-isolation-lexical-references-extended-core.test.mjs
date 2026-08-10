import { describe, it, expect } from "vitest";
import * as helper from "./azure-release-test-source-isolation-lexical-references.test-helper.mjs";

const inspectSourceIsolationLexicalReferences = helper.inspectSourceIsolationLexicalReferences;

describe("extended lexical core", () => {
  it("resolves shorthand values and traverses assignment defaults", () => {
    const objectSource = `const local = 1;\n({ local, unbound });`;
    expect(inspectSourceIsolationLexicalReferences(objectSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "unbound", node: "Identifier", start: 27, line: 2, column: 11 }
      ]
    });

    const assignmentSource = `let target;\n({ target = fallback } = source);`;
    expect(inspectSourceIsolationLexicalReferences(assignmentSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "fallback", node: "Identifier", start: 24, line: 2, column: 13 },
        { text: "source", node: "Identifier", start: 37, line: 2, column: 26 }
      ]
    });
  });

  it("treats top-level arguments and arrows as unbound", () => {
    expect(inspectSourceIsolationLexicalReferences(`arguments;`)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 0, line: 1, column: 1 }
      ]
    });

    expect(inspectSourceIsolationLexicalReferences(`() => arguments;`)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 6, line: 1, column: 7 }
      ]
    });
  });

  it("binds arguments in non-arrow function bodies", () => {
    const functionSource = `function f() { arguments; (() => arguments); }`;
    expect(inspectSourceIsolationLexicalReferences(functionSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: []
    });

    const membersSource = `class C { method() { arguments; } constructor() { arguments; } get g() { arguments; } set s(v) { arguments; } }`;
    expect(inspectSourceIsolationLexicalReferences(membersSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: []
    });
  });

  it("blocks outer arguments in field initializers and static blocks", () => {
    const fieldSource = `function f() { class C { field = arguments; fieldArrow = () => arguments; } }`;
    expect(inspectSourceIsolationLexicalReferences(fieldSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 33, line: 1, column: 34 },
        { text: "arguments", node: "Identifier", start: 63, line: 1, column: 64 }
      ]
    });

    const staticSource = `function f() { class C { static { arguments; (() => arguments); } } }`;
    expect(inspectSourceIsolationLexicalReferences(staticSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 34, line: 1, column: 35 },
        { text: "arguments", node: "Identifier", start: 52, line: 1, column: 53 }
      ]
    });
  });

  it("inherits outer arguments through computed member names", () => {
    const source = `function outer() {
  class Inner {
    [arguments]() { return arguments; }
    get [arguments]() { return arguments; }
    set [arguments](value) { arguments; }
    [arguments] = 1;
  }
}
class Top {
  [arguments]() { return arguments; }
  get [arguments]() { return arguments; }
  set [arguments](value) { arguments; }
  [arguments] = 1;
}`;
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 203, line: 10, column: 4 },
        { text: "arguments", node: "Identifier", start: 245, line: 11, column: 8 },
        { text: "arguments", node: "Identifier", start: 287, line: 12, column: 8 },
        { text: "arguments", node: "Identifier", start: 323, line: 13, column: 4 }
      ]
    });
  });

  it("handles nearer functions, decoded arguments, and shorthand arguments", () => {
    const nearerFunction = `class C { field = function() { arguments; }; }`;
    expect(inspectSourceIsolationLexicalReferences(nearerFunction)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: []
    });

    expect(inspectSourceIsolationLexicalReferences(`\\u0061rguments;`)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: [
        { text: "arguments", node: "Identifier", start: 0, line: 1, column: 1 }
      ]
    });

    const shorthandSource = `function f() { ({ arguments }); }`;
    expect(inspectSourceIsolationLexicalReferences(shorthandSource)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: ["lexical-bindings", "unbound-references"],
      unboundReferences: []
    });
  });
});
