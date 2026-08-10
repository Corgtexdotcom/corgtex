import { describe, it, expect } from "vitest";
import * as helper from "./azure-release-test-source-isolation-lexical-references.test-helper.mjs";

const inspectSourceIsolationLexicalReferences = helper.inspectSourceIsolationLexicalReferences;

describe("ordinary lexical core", () => {
  it("API and immutability", () => {
    expect(Object.keys(helper)).toStrictEqual(["inspectSourceIsolationLexicalReferences"]);
    expect(() => inspectSourceIsolationLexicalReferences(null)).toThrow(TypeError);
    expect(() => inspectSourceIsolationLexicalReferences(1)).toThrow(TypeError);

    const result1 = inspectSourceIsolationLexicalReferences("fetch; fetch;");
    const result2 = inspectSourceIsolationLexicalReferences("fetch; fetch;");

    expect(result1).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: [
        {
          text: "fetch",
          node: "Identifier",
          start: 0,
          line: 1,
          column: 1
        },
        {
          text: "fetch",
          node: "Identifier",
          start: 7,
          line: 1,
          column: 8
        }
      ]
    });

    expect(result2).toStrictEqual(result1);
    expect(result1).not.toBe(result2);
    expect(result1.capabilities).not.toBe(result2.capabilities);
    expect(result1.unboundReferences).not.toBe(result2.unboundReferences);
    expect(result1.unboundReferences[0]).not.toBe(result2.unboundReferences[0]);
    expect(result1.unboundReferences[1]).not.toBe(result2.unboundReferences[1]);
    expect(Object.isFrozen(result1)).toBe(true);
    expect(Object.isFrozen(result1.capabilities)).toBe(true);
    expect(Object.isFrozen(result1.unboundReferences)).toBe(true);
    expect(Object.isFrozen(result1.unboundReferences[0])).toBe(true);
    expect(Object.isFrozen(result1.unboundReferences[1])).toBe(true);
    expect(Object.keys(result1).sort()).toStrictEqual(["capabilities", "complete", "phase", "unboundReferences"]);
    expect(Object.keys(result1.unboundReferences[0]).sort()).toStrictEqual(["column", "line", "node", "start", "text"]);
  });

  it("Closed bound baseline", () => {
    const source = `import { imported as importedValue } from "closed-module";\nfunction outer(parameter) {\n  try { throw parameter; } catch (caught) { return importedValue + caught; }\n}\nclass LocalClass {}\nouter(new LocalClass());`;
    const result = {
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: []
    };
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual(result);
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual(result);
  });

  it("Ordinary reads/writes/Unicode", () => {
    const source = `const local = 1;\nlocal + fetch + missingName;\nsafeGlobal = local;\nf\\u0065tch;`;
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: [
        { text: "fetch", node: "Identifier", start: 25, line: 2, column: 9 },
        { text: "missingName", node: "Identifier", start: 33, line: 2, column: 17 },
        { text: "safeGlobal", node: "Identifier", start: 46, line: 3, column: 1 },
        { text: "fetch", node: "Identifier", start: 66, line: 4, column: 1 }
      ]
    });
  });

  it("Receiver/computed roles", () => {
    const source = `const local = 1;\nfetch.member = local;\nmissing[computed] = local;`;
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: [
        { text: "fetch", node: "Identifier", start: 17, line: 2, column: 1 },
        { text: "missing", node: "Identifier", start: 39, line: 3, column: 1 },
        { text: "computed", node: "Identifier", start: 47, line: 3, column: 9 }
      ]
    });
  });

  it("Forced-module scope", () => {
    const source = `{ function fetch() {} }\nfetch;`;
    expect(inspectSourceIsolationLexicalReferences(source)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: [
        { text: "fetch", node: "Identifier", start: 24, line: 2, column: 1 }
      ]
    });
  });

  it("Arguments excluded roles and checker-first bindings", () => {
    const controls = `
      const arguments = 1;
      arguments;
      ({ arguments });
      const arrow = (arguments) => arguments;
      function f(arguments) { return arguments; }
      function local() { const arguments = 2; return arguments; }
      const obj = { arguments: 1, arguments() {} };
      class C { arguments = 1; arguments() {} get arguments() {} }
      obj.arguments;
      arguments: while(false) { break arguments; continue arguments; }
      export { arguments };
      import { arguments } from "mod";
      import data from "pkg" with { type: "json" }; data;
      export * as publicName from "pkg";
      import data2 from "pkg" with { type: json }; data2;
      import data3 from "pkg" with { type: arguments }; data3;
      export as namespace arguments;
      import data4 from "pkg" with { type: arguments.member }; data4;
    `;
    expect(inspectSourceIsolationLexicalReferences(controls)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: []
    });
  });

  it("Diagnostic boundary", () => {
    expect(() => inspectSourceIsolationLexicalReferences(`await;`)).toThrow(SyntaxError);
    expect(() => inspectSourceIsolationLexicalReferences(`const class = 1;`)).toThrow(SyntaxError);

    expect(inspectSourceIsolationLexicalReferences(`return safeGlobal;`)).toStrictEqual({
      phase: "lexical-unbound-references",
      complete: false,
      capabilities: [
        "lexical-bindings",
        "unbound-references"
      ],
      unboundReferences: [
        { text: "safeGlobal", node: "Identifier", start: 7, line: 1, column: 8 }
      ]
    });
  });
});
