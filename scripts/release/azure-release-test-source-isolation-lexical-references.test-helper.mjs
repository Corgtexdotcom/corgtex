import ts from "typescript";

export function inspectSourceIsolationLexicalReferences(source) {
  if (typeof source !== "string") throw new TypeError("Source must be a string");

  const options = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowJs: true,
    checkJs: true,
    noLib: true,
    noResolve: true,
    types: []
  };

  let cachedSourceFile;

  const host = {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      if (fileName !== "source.mjs") throw new Error("File not found");
      if (!cachedSourceFile) {
        cachedSourceFile = ts.createSourceFile(
          fileName,
          source,
          languageVersionOrOptions,
          true,
          ts.ScriptKind.JS
        );
        ts.getSetExternalModuleIndicator(options)(cachedSourceFile);
      }
      return cachedSourceFile;
    },
    fileExists: (fileName) => {
      if (fileName !== "source.mjs") throw new Error("File not found");
      return true;
    },
    readFile: (fileName) => {
      if (fileName !== "source.mjs") throw new Error("File not found");
      return source;
    },
    directoryExists: () => { throw new Error("Not implemented"); },
    getDirectories: () => { throw new Error("Not implemented"); },
    writeFile: () => { throw new Error("Not implemented"); },
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    resolveModuleNames: (names) => names.map(() => undefined)
  };

  const program = ts.createProgram(["source.mjs"], options, host);
  const sourceFile = program.getSourceFile("source.mjs");

  if (!sourceFile) throw new Error("Source file not found");
  if (sourceFile !== cachedSourceFile) throw new Error("Source file mismatch");
  if (!ts.isExternalModule(sourceFile)) throw new Error("Source file is not an external module");

  if (sourceFile.parseDiagnostics && sourceFile.parseDiagnostics.length > 0) {
    throw new SyntaxError("Parse diagnostics found");
  }
  if (program.getSyntacticDiagnostics(sourceFile).length > 0) {
    throw new SyntaxError("Parse/syntactic diagnostics found");
  }

  let hasUnsupported = false;

  function isExcludedRole(node) {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    if (ts.isParameter(parent) && parent.name === node) return true;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
    if (ts.isFunctionExpression(parent) && parent.name === node) return true;
    if (ts.isClassDeclaration(parent) && parent.name === node) return true;
    if (ts.isClassExpression(parent) && parent.name === node) return true;
    if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
    if (ts.isImportClause(parent) && parent.name === node) return true;
    if (ts.isNamespaceImport(parent) && parent.name === node) return true;
    if ((ts.isNamespaceExport(parent) || ts.isNamespaceExportDeclaration(parent)) && parent.name === node) return true;
    if (ts.isImportAttribute(parent)) return true;
    if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
    if (ts.isGetAccessor(parent) && parent.name === node) return true;
    if (ts.isSetAccessor(parent) && parent.name === node) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if (ts.isLabeledStatement(parent) && parent.label === node) return true;
    if (ts.isBreakStatement(parent) && parent.label === node) return true;
    if (ts.isContinueStatement(parent) && parent.label === node) return true;
    if (ts.isMetaProperty(parent)) return true;
    return false;
  }

  function preflight(node) {
    if (ts.isShorthandPropertyAssignment(node)) {
      hasUnsupported = true;
    }
    if (ts.isIdentifier(node) && node.text === "arguments" && !isExcludedRole(node)) {
      hasUnsupported = true;
    }
    if (!ts.isImportAttribute(node)) ts.forEachChild(node, preflight);
  }
  preflight(sourceFile);

  if (hasUnsupported) {
    throw new Error("Unsupported lexical reference form");
  }

  const checker = program.getTypeChecker();
  program.getSemanticDiagnostics(sourceFile);

  const unboundReferences = [];

  function isAllowlistedDeclaration(decl) {
    if (!decl) return false;
    return ts.isVariableDeclaration(decl) ||
           ts.isBindingElement(decl) ||
           ts.isParameter(decl) ||
           ts.isFunctionDeclaration(decl) ||
           ts.isFunctionExpression(decl) ||
           ts.isClassDeclaration(decl) ||
           ts.isClassExpression(decl) ||
           ts.isImportClause(decl) ||
           ts.isImportSpecifier(decl) ||
           ts.isNamespaceImport(decl);
  }

  function visit(node) {
    if (ts.isIdentifier(node) && !isExcludedRole(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      let isBound = false;
      if (symbol && symbol.declarations) {
        for (const decl of symbol.declarations) {
          if (decl.getSourceFile() === sourceFile && isAllowlistedDeclaration(decl)) {
            isBound = true;
            break;
          }
        }
      }
      if (!isBound) {
        const lineAndChar = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        unboundReferences.push({
          text: node.text,
          node: "Identifier",
          start: node.getStart(sourceFile),
          line: lineAndChar.line + 1,
          column: lineAndChar.character + 1
        });
      }
    }
    if (!ts.isImportAttribute(node)) ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const deduplicated = [];
  const seen = new Set();
  for (const ref of unboundReferences) {
    const key = `${ref.node}|${ref.start}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(ref);
    }
  }

  deduplicated.sort((a, b) => a.start - b.start);

  return Object.freeze({
    phase: "lexical-ordinary-unbound-references",
    complete: false,
    capabilities: Object.freeze([
      "ordinary-identifier-lexical-bindings",
      "ordinary-unbound-references"
    ]),
    unboundReferences: Object.freeze(deduplicated.map(ref => Object.freeze(ref)))
  });
}
