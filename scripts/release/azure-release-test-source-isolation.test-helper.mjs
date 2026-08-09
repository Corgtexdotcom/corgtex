import ts from "typescript";

const MODULE_BINDING_RESERVED = new Set([
  "arguments", "await", "eval", "implements", "interface", "let", "package", "private", "protected", "public",
  "static", "yield"
]);

function isIdentifierName(value) {
  return typeof value === "string" && ts.isIdentifierText(value, ts.ScriptTarget.Latest, ts.LanguageVariant.Standard);
}

function isModuleBindingIdentifier(value) {
  if (!isIdentifierName(value) || MODULE_BINDING_RESERVED.has(value)) return false;
  const source = ts.createSourceFile(
    "binding.mjs",
    `export {}; const ${value} = 0;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  return source.parseDiagnostics.length === 0;
}

function validateBinding(binding) {
  if (typeof binding !== "string" || binding.length === 0) throw new TypeError("Invalid binding");
  const localMatch = /^(?:default|namespace)=(.*)$/.exec(binding);
  if (localMatch) {
    if (!isModuleBindingIdentifier(localMatch[1])) throw new TypeError("Invalid local binding");
    return;
  }
  const namedMatch = /^named:(.*?)=(.*)$/.exec(binding);
  if (!namedMatch || !isIdentifierName(namedMatch[1]) || !isModuleBindingIdentifier(namedMatch[2])) {
    throw new TypeError("Invalid named binding");
  }
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Invalid policy");
  if (Object.keys(policy).length !== 1 || !Array.isArray(policy.permittedImports)) throw new TypeError("Invalid policy shape");
  const modules = new Set();
  const permittedImports = policy.permittedImports.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid import entry");
    if (Object.keys(entry).length !== 2 || typeof entry.module !== "string" || !Array.isArray(entry.bindings)) {
      throw new TypeError("Invalid import shape");
    }
    if (entry.module.length === 0 || modules.has(entry.module)) throw new TypeError("Invalid or duplicate module");
    modules.add(entry.module);
    const bindings = new Set();
    for (const binding of entry.bindings) {
      validateBinding(binding);
      if (bindings.has(binding)) throw new TypeError("Duplicate binding");
      bindings.add(binding);
    }
    return { module: entry.module, bindings: [...bindings].sort() };
  });
  return permittedImports.sort((left, right) => left.module.localeCompare(right.module));
}

function importSignature(node) {
  if (node.attributes || node.assertClause || !ts.isStringLiteral(node.moduleSpecifier)) return null;
  const bindings = [];
  const clause = node.importClause;
  if (!clause) return { module: node.moduleSpecifier.text, bindings };
  if (clause.isTypeOnly || clause.phaseModifier) return null;
  if (clause.name) bindings.push(`default=${clause.name.text}`);
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.push(`namespace=${named.name.text}`);
  if (named && ts.isNamedImports(named)) {
    if (named.elements.length === 0) return null;
    for (const element of named.elements) {
      if (element.isTypeOnly) return null;
      const imported = element.propertyName?.text ?? element.name.text;
      bindings.push(`named:${imported}=${element.name.text}`);
    }
  }
  if (bindings.length === 0) return null;
  return { module: node.moduleSpecifier.text, bindings: bindings.sort() };
}

function bindingsEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createSourceIsolationImportKernel(policy) {
  const permittedImports = normalizePolicy(policy);
  const permittedByModule = new Map(permittedImports.map((entry) => [entry.module, entry.bindings]));
  return {
    inspect(source) {
      if (typeof source !== "string") throw new TypeError("Source must be a string");
      const sourceFile = ts.createSourceFile("source.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      if (sourceFile.parseDiagnostics.length > 0) throw new SyntaxError("Invalid module source");
      const findings = [];
      const seen = new Set();
      const matchedModules = new Set();
      function addFinding(code, node) {
        const start = ts.isSourceFile(node) ? 0 : node.getStart(sourceFile);
        const nodeName = ts.SyntaxKind[node.kind];
        const key = `${code}|${nodeName}|${start}`;
        if (seen.has(key)) return;
        seen.add(key);
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        findings.push({ code, node: nodeName, line: position.line + 1, column: position.character + 1 });
      }
      function visit(node) {
        if (ts.isImportDeclaration(node)) {
          const signature = importSignature(node);
          const permittedBindings = signature ? permittedByModule.get(signature.module) : undefined;
          const exact = permittedBindings && !matchedModules.has(signature.module) && bindingsEqual(signature.bindings, permittedBindings);
          if (exact) matchedModules.add(signature.module);
          else addFinding("IMPORT_FORBIDDEN", node);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          addFinding("IMPORT_FORBIDDEN", node);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addFinding("IMPORT_DYNAMIC", node);
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
      if (matchedModules.size !== permittedImports.length) addFinding("IMPORT_FORBIDDEN", sourceFile);
      findings.sort((left, right) => {
        return left.line - right.line || left.column - right.column || left.code.localeCompare(right.code) || left.node.localeCompare(right.node);
      });
      return {
        phase: "imports",
        complete: false,
        capabilities: ["finding-schema", "static-imports", "dynamic-imports"],
        findings
      };
    }
  };
}
