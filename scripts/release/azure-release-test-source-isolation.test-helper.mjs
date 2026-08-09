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
  const localMatch = /^(default|namespace)=(.*)$/.exec(binding);
  if (localMatch) {
    if (!isModuleBindingIdentifier(localMatch[2])) throw new TypeError("Invalid local binding");
    return { kind: localMatch[1], local: localMatch[2] };
  }
  const namedMatch = /^named:(.*?)=(.*)$/.exec(binding);
  if (!namedMatch || !isIdentifierName(namedMatch[1]) || !isModuleBindingIdentifier(namedMatch[2])) {
    throw new TypeError("Invalid named binding");
  }
  return { kind: "named", local: namedMatch[2] };
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Invalid policy");
  if (Object.keys(policy).length !== 1 || !Array.isArray(policy.permittedImports)) throw new TypeError("Invalid policy shape");
  const modules = new Set();
  const policyLocals = new Set();
  const permittedImports = policy.permittedImports.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid import entry");
    if (Object.keys(entry).length !== 2 || typeof entry.module !== "string" || !Array.isArray(entry.bindings)) {
      throw new TypeError("Invalid import shape");
    }
    if (entry.module.length === 0 || modules.has(entry.module)) throw new TypeError("Invalid or duplicate module");
    modules.add(entry.module);
    const bindings = new Set();
    const entryLocals = new Set();
    const kinds = { default: 0, namespace: 0, named: 0 };
    for (const binding of entry.bindings) {
      if (bindings.has(binding)) throw new TypeError("Duplicate binding");
      const parsed = validateBinding(binding);
      if (entryLocals.has(parsed.local) || policyLocals.has(parsed.local)) throw new TypeError("Duplicate local binding");
      bindings.add(binding);
      entryLocals.add(parsed.local);
      policyLocals.add(parsed.local);
      kinds[parsed.kind] += 1;
    }
    const unrepresentable = kinds.default > 1 || kinds.namespace > 1 || (kinds.namespace > 0 && kinds.named > 0);
    if (unrepresentable) throw new TypeError("Unrepresentable import");
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

function importLocalNames(node) {
  const clause = node.importClause;
  if (!clause) return [];
  const locals = clause.name ? [clause.name.text] : [];
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) locals.push(named.name.text);
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) locals.push(element.name.text);
  }
  return locals;
}

function isDynamicImportCall(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function supportBinding(statement) {
  if (!ts.isVariableStatement(statement) || statement.modifiers?.length) return null;
  if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return null;
  if (statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || declaration.type || declaration.exclamationToken) return null;
  if (!isModuleBindingIdentifier(declaration.name.text)) return null;
  const initializer = declaration.initializer;
  if (!initializer) return null;
  const importMeta = ts.isMetaProperty(initializer) && initializer.keywordToken === ts.SyntaxKind.ImportKeyword && initializer.name.text === "meta";
  const dynamic = isDynamicImportCall(initializer);
  const arrow = ts.isArrowFunction(initializer)
    && !initializer.modifiers?.length
    && !initializer.typeParameters?.length
    && !initializer.type
    && initializer.parameters.length === 0
    && isDynamicImportCall(initializer.body);
  return importMeta || dynamic || arrow ? declaration.name.text : null;
}

function validatePotentialCleanTrivia(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  for (let kind = scanner.scan();; kind = scanner.scan()) {
    const triviaEnd = kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia ? scanner.getTextPos() : scanner.getTokenPos();
    const trivia = source.slice(scanner.getStartPos(), triviaEnd);
    if (!/^[\t\v\f \u00A0\uFEFF\n\r\u2028\u2029\p{Zs}]*$/u.test(trivia)) throw new SyntaxError("Invalid ECMAScript trivia");
    if (kind === ts.SyntaxKind.EndOfFileToken) return;
  }
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
      const supportBindings = new Map();
      const localOwners = new Map();
      for (const statement of sourceFile.statements) {
        const support = supportBinding(statement);
        const locals = ts.isImportDeclaration(statement) ? importLocalNames(statement) : support ? [support] : [];
        if (support) supportBindings.set(statement, support);
        for (const local of locals) {
          const owners = localOwners.get(local) ?? [];
          owners.push(statement);
          localOwners.set(local, owners);
        }
      }
      const collidingStatements = new Set();
      for (const owners of localOwners.values()) {
        if (owners.length > 1) owners.forEach((statement) => collidingStatements.add(statement));
      }
      function addFinding(code, node) {
        const start = ts.isSourceFile(node) ? 0 : node.getStart(sourceFile);
        const nodeName = ts.SyntaxKind[node.kind];
        const key = `${code}|${nodeName}|${start}`;
        if (seen.has(key)) return;
        seen.add(key);
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        findings.push({ code, node: nodeName, line: position.line + 1, column: position.character + 1 });
      }
      for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
          const eligible = !statement.modifiers?.length && !collidingStatements.has(statement);
          const signature = eligible ? importSignature(statement) : null;
          const permittedBindings = signature ? permittedByModule.get(signature.module) : undefined;
          const exact = permittedBindings && !matchedModules.has(signature.module) && bindingsEqual(signature.bindings, permittedBindings);
          if (exact) matchedModules.add(signature.module);
          else addFinding("IMPORT_FORBIDDEN", statement);
        } else if (!supportBindings.has(statement) || collidingStatements.has(statement)) {
          addFinding("IMPORT_FORBIDDEN", statement);
        }
      }
      function visitDynamic(node) {
        if (isDynamicImportCall(node)) addFinding("IMPORT_DYNAMIC", node);
        ts.forEachChild(node, visitDynamic);
      }
      visitDynamic(sourceFile);
      if (matchedModules.size !== permittedImports.length) addFinding("IMPORT_FORBIDDEN", sourceFile);
      if (findings.length === 0) validatePotentialCleanTrivia(source);
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
