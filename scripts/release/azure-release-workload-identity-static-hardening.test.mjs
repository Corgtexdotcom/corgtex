import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const productionSource = readFileSync(new URL("./azure-release-workload-identity.mjs", import.meta.url), "utf8");
const testSource = readFileSync(new URL(import.meta.url), "utf8");
const providerAssessorName = ["assessAzureRelease", "ProviderIdentity"].join("");
const workloadAssessorName = ["assessAzureRelease", "WorkloadIdentity"].join("");
const statusName = "AZURE_RELEASE_CONTRACT_STATUS";
const providerModule = "./azure-release-provider-identity.mjs";
const apostrophe = String.fromCharCode(39);
const templateQuote = String.fromCharCode(96);
const gap = "(?:[ \\t\\r\\n]|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\r\\n]*(?:\\r\\n|\\n))*";
const horizontalGap = "(?:[ \\t]|\\/\\*[\\s\\S]*?\\*\\/)*";
const statementEnd = horizontalGap + "(?:;|\\/\\/[^\\r\\n]*(?=\\r?\\n|$)|(?=\\r?\\n|$))";
const identifierStart = "(?<![A-Za-z0-9_$])";
const identifierEnd = "(?![A-Za-z0-9_$])";
const keyword = (value) => identifierStart + value + identifierEnd;
const quote = "([\"\\x27])";
const escapedProviderModule = "\\./azure-release-provider-identity\\.mjs";
const importBindings = "(?:" + statusName + gap + "," + gap + providerAssessorName + "|" + providerAssessorName + gap + "," + gap + statusName + ")";
const exactImportBody = keyword("import") + gap + "\\{" + gap + importBindings + gap + "\\}" + gap + keyword("from") + gap + quote + escapedProviderModule + "\\1" + statementEnd;
const exactExportBody = keyword("export") + gap + "\\{" + gap + statusName + gap + "\\}" + statementEnd;
const staticImportStart = keyword("import") + gap + "(?=\\{|\\*|[A-Za-z_$]|[\"\\x27])";
const boundary = "(?:^|[;\\r\\n])" + gap;
const exactProviderImportMatcher = new RegExp(boundary + exactImportBody, "m");
const exactLocalStatusExportMatcher = new RegExp(boundary + exactExportBody, "m");
const additionalStaticImportMatcher = new RegExp(boundary + "(?!" + exactImportBody + ")" + staticImportStart, "m");
const namedSourceReexportMatcher = new RegExp(boundary + keyword("export") + gap + "\\{" + "[\\s\\S]*?\\}" + gap + keyword("from") + gap + quote + "[^\"\\x27]+\\1" + statementEnd, "m");
const starSourceReexportMatcher = new RegExp(boundary + keyword("export") + gap + "\\*" + "(?:" + gap + keyword("as") + gap + "[A-Za-z_$][\\w$]*)?" + gap + keyword("from") + gap + quote + "[^\"\\x27]+\\1" + statementEnd, "m");
const dynamicImportMatcher = new RegExp(keyword("import") + gap + "\\(");
const commonjsEnvironmentMatcher = new RegExp(keyword("require") + gap + "\\(|" + keyword("process") + gap + "(?=\\.|\\?\\.|\\[)|" + keyword("import") + gap + "\\." + gap + keyword("meta") + gap + "\\." + gap + keyword("env") + "|" + keyword("dotenv") + "|" + keyword("DATABASE_URL"));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function markerPattern(marker) {
  const escaped = escapeRegExp(marker.name);
  if (marker.kind === "call") return identifierStart + escaped + identifierEnd + gap + "\\(";
  if (marker.kind === "call-or-construct") return "(?:" + keyword("new") + gap + ")?" + identifierStart + escaped + identifierEnd + gap + "\\(";
  if (marker.kind === "member") return identifierStart + escaped + identifierEnd + gap + "(?=\\.|\\?\\.|\\[)";
  if (marker.kind === "string-exact") return "[\"\\x27]" + escaped + "[\"\\x27]";
  if (marker.kind === "string-part") return "[\"\\x27](?:[^\"\\x27]*[^A-Za-z0-9_.-])?" + escaped + "(?![A-Za-z0-9_.-])[^\"\\x27]*[\"\\x27]";
  return identifierStart + escaped + identifierEnd;
}
function staticModuleSpecifiers(source) {
  const file = ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return file.statements.flatMap((statement) => {
    const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
    return declaration && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
  });
}
function tokenMatcher(markers) {
  const moduleMarkers = markers.filter((marker) => ["module", "module-prefix"].includes(marker.kind));
  const rawMarkers = markers.filter((marker) => !moduleMarkers.includes(marker));
  const rawMatcher = rawMarkers.length > 0 ? new RegExp(rawMarkers.map(markerPattern).join("|")) : null;
  return { global: false, sticky: false, test(source) {
    const specifiers = moduleMarkers.length > 0 ? staticModuleSpecifiers(source) : [];
    const moduleMatch = moduleMarkers.some((marker) => specifiers.some((specifier) => marker.kind === "module" ? specifier === marker.name : specifier.startsWith(marker.name)));
    return moduleMatch || rawMatcher?.test(source) === true;
  } };
}
function listed(kind, names) {
  return names.map((name) => ({ name, kind }));
}

const tokenFamilies = [
  { name: "filesystem", markers: [...listed("module", ["node:fs", "node:fs/promises", "fs", "fs/promises"]), ...listed("identifier", ["readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "open", "openSync", "createReadStream", "createWriteStream", "unlink", "unlinkSync", "rm", "rmSync", "rename", "renameSync", "mkdir", "mkdirSync"])] },
  { name: "subprocess", markers: [...listed("module", ["node:child_process", "child_process"]), ...listed("call", ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]), ...listed("identifier", ["shell"])] },
  { name: "network-socket", markers: [...listed("module", ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns"]), ...listed("call", ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"])] },
  { name: "timers", markers: [...listed("module", ["node:timers", "node:timers/promises"]), ...listed("call", ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"])] },
  { name: "logging-ambient-globals", markers: listed("member", ["console", "logger", "globalThis", "global", "window"]) },
  { name: "code-generation", markers: [...listed("call", ["eval"]), ...listed("call-or-construct", ["Function"])] },
  { name: "provider-sdk-cli", markers: [...listed("module-prefix", ["@azure/"]), ...listed("identifier", ["AzureCliCredential", "DefaultAzureCredential", "ClientSecretCredential", "ManagedIdentityCredential", "ContainerAppsAPIClient", "ContainerRegistryManagementClient", "ApplicationInsightsManagementClient"]), ...listed("string-exact", ["az", "railway"]), ...listed("string-part", ["backboard.railway.app", "railway.app/graphql", "RAILWAY_API_TOKEN"])] },
  { name: "runner-control-plane", markers: [...listed("identifier", ["runCommand", "controlPlane", "recordVerifiedRelease", "latestRailwayStatus", "runFleetRelease"]), ...listed("string-part", ["fleet-release-runner", "fleet-release-probes", "fleet-release-alerts", "/api/control-plane"])] },
  { name: "config-credential-effect", markers: listed("identifier", ["config", "env", "deps", "credential", "secret", "token", "password", "effect", "mutation", "mutate"]) },
  { name: "successor-routes", markers: listed("identifier", ["subscriptionId", "tenantId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName", "applicationInsightsConnectionString", "runtimeOrigin", "domain", "dns", "url", "image", "digest", "revision", "traffic", "action", "operation"]) }
].map((family) => ({ ...family, matcher: tokenMatcher(family.markers) }));

const structuralFamilies = [
  { name: "exact-provider-named-import", matcher: exactProviderImportMatcher },
  { name: "exact-local-status-export", matcher: exactLocalStatusExportMatcher },
  { name: "additional-static-import", matcher: additionalStaticImportMatcher },
  { name: "named-source-reexport", matcher: namedSourceReexportMatcher },
  { name: "star-source-reexport", matcher: starSourceReexportMatcher },
  { name: "dynamic-import", matcher: dynamicImportMatcher },
  { name: "commonjs-environment", matcher: commonjsEnvironmentMatcher }
];
const families = [...structuralFamilies, ...tokenFamilies];
const familyNames = ["exact-provider-named-import", "exact-local-status-export", "additional-static-import", "named-source-reexport", "star-source-reexport", "dynamic-import", "commonjs-environment", "filesystem", "subprocess", "network-socket", "timers", "logging-ambient-globals", "code-generation", "provider-sdk-cli", "runner-control-plane", "config-credential-effect", "successor-routes"];

const permittedImport = "import { " + statusName + ", " + providerAssessorName + " } from \"" + providerModule + "\";";
const permittedImportNoSemicolon = permittedImport.slice(0, -1);
const permittedImportReverse = "import{" + providerAssessorName + "," + statusName + "}from" + apostrophe + providerModule + apostrophe + ";";
const permittedExport = "export { " + statusName + " };";
const permittedExportNoSemicolon = permittedExport.slice(0, -1);
const statusDeclaration = "const " + statusName + " = 1;\n";
const structuralRows = [
  { name: "exact-import-direct", family: familyNames[0], source: permittedImport, expected: true },
  { name: "exact-import-asi-eof", family: familyNames[0], source: permittedImportNoSemicolon, expected: true },
  { name: "exact-import-asi-next", family: familyNames[0], source: permittedImportNoSemicolon + "\nconst next = 1;", expected: true },
  { name: "exact-import-reverse-single-quote", family: familyNames[0], source: permittedImportReverse, expected: true },
  { name: "exact-import-tab", family: familyNames[0], source: "import\t{\t" + statusName + "\t,\t" + providerAssessorName + "\t}\tfrom\t\"" + providerModule + "\"\t;", expected: true },
  { name: "exact-import-block", family: familyNames[0], source: "import/*a*/{/*b*/" + statusName + "/*c*/,/*d*/" + providerAssessorName + "/*e*/}/*f*/from/*g*/\"" + providerModule + "\";", expected: true },
  { name: "exact-import-lf", family: familyNames[0], source: "import//a\n{//b\n" + statusName + ",//c\n" + providerAssessorName + "}//d\nfrom//e\n\"" + providerModule + "\";", expected: true },
  { name: "exact-import-crlf", family: familyNames[0], source: "import//a\r\n{//b\r\n" + statusName + ",//c\r\n" + providerAssessorName + "}//d\r\nfrom//e\r\n\"" + providerModule + "\";", expected: true },
  { name: "exact-import-wrong-source", family: familyNames[0], source: permittedImport.replace(providerModule, "./wrong.mjs"), expected: false },
  { name: "exact-import-missing-status", family: familyNames[0], source: "import { " + providerAssessorName + " } from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-missing-provider", family: familyNames[0], source: "import { " + statusName + " } from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-alias", family: familyNames[0], source: "import { " + statusName + ", " + providerAssessorName + " as alias } from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-third", family: familyNames[0], source: "import { " + statusName + ", " + providerAssessorName + ", extra } from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-default", family: familyNames[0], source: "import value, { " + statusName + ", " + providerAssessorName + " } from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-namespace", family: familyNames[0], source: "import * as value from \"" + providerModule + "\";", expected: false },
  { name: "exact-import-side-effect", family: familyNames[0], source: "import \"" + providerModule + "\";", expected: false },
  { name: "exact-import-second", family: familyNames[0], source: permittedImport + "\nimport value from \"./other.mjs\";", expected: true },
  { name: "exact-export-direct", family: familyNames[1], source: statusDeclaration + permittedExport, expected: true },
  { name: "exact-export-asi-eof", family: familyNames[1], source: statusDeclaration + permittedExportNoSemicolon, expected: true },
  { name: "exact-export-asi-next", family: familyNames[1], source: statusDeclaration + permittedExportNoSemicolon + "\nconst next = 1;", expected: true },
  { name: "exact-export-tab", family: familyNames[1], source: statusDeclaration + "export\t{\t" + statusName + "\t}\t;", expected: true },
  { name: "exact-export-block", family: familyNames[1], source: statusDeclaration + "export/*a*/{/*b*/" + statusName + "/*c*/}/*d*/;", expected: true },
  { name: "exact-export-lf", family: familyNames[1], source: statusDeclaration + "export//a\n{//b\n" + statusName + "//c\n};", expected: true },
  { name: "exact-export-crlf", family: familyNames[1], source: statusDeclaration + "export//a\r\n{//b\r\n" + statusName + "//c\r\n};", expected: true },
  { name: "exact-export-alias", family: familyNames[1], source: statusDeclaration + "export { " + statusName + " as status };", expected: false },
  { name: "exact-export-extra", family: familyNames[1], source: statusDeclaration + "const extra = 2;\nexport { " + statusName + ", extra };", expected: false },
  { name: "exact-export-from", family: familyNames[1], source: "export { " + statusName + " } from \"./module.mjs\";", expected: false },
  { name: "additional-wrong-source", family: familyNames[2], source: permittedImport.replace(providerModule, "./wrong.mjs"), expected: true },
  { name: "additional-missing-binding", family: familyNames[2], source: "import { " + statusName + " } from \"" + providerModule + "\";", expected: true },
  { name: "additional-alias", family: familyNames[2], source: "import { " + statusName + " as status, " + providerAssessorName + " } from \"" + providerModule + "\";", expected: true },
  { name: "additional-default", family: familyNames[2], source: "import value from \"./module.mjs\";", expected: true },
  { name: "additional-asi-eof", family: familyNames[2], source: "import value from \"./module.mjs\"", expected: true },
  { name: "additional-asi-next", family: familyNames[2], source: permittedImportNoSemicolon + "\nimport value from \"./other.mjs\"\nconst next = 1;", expected: true },
  { name: "additional-default-single-quote", family: familyNames[2], source: "import value from " + apostrophe + "./module.mjs" + apostrophe + ";", expected: true },
  { name: "additional-tab", family: familyNames[2], source: "import\tvalue\tfrom\t\"./module.mjs\";", expected: true },
  { name: "additional-block", family: familyNames[2], source: "import/*a*/value/*b*/from/*c*/\"./module.mjs\";", expected: true },
  { name: "additional-lf", family: familyNames[2], source: "import//a\nvalue//b\nfrom//c\n\"./module.mjs\";", expected: true },
  { name: "additional-crlf", family: familyNames[2], source: "import//a\r\nvalue//b\r\nfrom//c\r\n\"./module.mjs\";", expected: true },
  { name: "additional-namespace", family: familyNames[2], source: "import * as value from \"./module.mjs\";", expected: true },
  { name: "additional-side-effect", family: familyNames[2], source: "import \"./module.mjs\";", expected: true },
  { name: "additional-second", family: familyNames[2], source: permittedImport + "\nimport value from \"./other.mjs\";", expected: true },
  { name: "additional-dynamic-near", family: familyNames[2], source: "const value = import(\"./module.mjs\");", expected: false },
  { name: "additional-meta-near", family: familyNames[2], source: "const value = import.meta.url;", expected: false },
  { name: "named-source-direct", family: familyNames[3], source: "export{value}from\"./module.mjs\";", expected: true },
  { name: "named-source-asi-eof", family: familyNames[3], source: "export { value } from \"./module.mjs\"", expected: true },
  { name: "named-source-asi-next", family: familyNames[3], source: "export { value } from \"./module.mjs\"\nconst next = 1;", expected: true },
  { name: "named-source-single-quote", family: familyNames[3], source: "export { value } from " + apostrophe + "./module.mjs" + apostrophe + ";", expected: true },
  { name: "named-source-tab", family: familyNames[3], source: "export\t{\tvalue\t}\tfrom\t\"./module.mjs\";", expected: true },
  { name: "named-source-comment", family: familyNames[3], source: "export/*a*/{/*b*/value/*c*/}/*d*/from/*e*/\"./module.mjs\";", expected: true },
  { name: "named-source-lf", family: familyNames[3], source: "export//a\n{//b\nvalue//c\n}//d\nfrom//e\n\"./module.mjs\";", expected: true },
  { name: "named-source-crlf", family: familyNames[3], source: "export//a\r\n{//b\r\nvalue//c\r\n}//d\r\nfrom//e\r\n\"./module.mjs\";", expected: true },
  { name: "named-source-near", family: familyNames[3], source: "export const value = 1;", expected: false },
  { name: "star-source-direct", family: familyNames[4], source: "export*from\"./module.mjs\";", expected: true },
  { name: "star-source-asi-eof", family: familyNames[4], source: "export * from \"./module.mjs\"", expected: true },
  { name: "star-source-asi-next", family: familyNames[4], source: "export * from \"./module.mjs\"\nconst next = 1;", expected: true },
  { name: "star-source-single-quote", family: familyNames[4], source: "export * from " + apostrophe + "./module.mjs" + apostrophe + ";", expected: true },
  { name: "star-source-as", family: familyNames[4], source: "export * as value from \"./module.mjs\";", expected: true },
  { name: "star-source-tab", family: familyNames[4], source: "export\t*\tfrom\t\"./module.mjs\";", expected: true },
  { name: "star-source-block", family: familyNames[4], source: "export/*a*/*/*b*/from/*c*/\"./module.mjs\";", expected: true },
  { name: "star-source-lf", family: familyNames[4], source: "export//a\n*//b\nfrom//c\n\"./module.mjs\";", expected: true },
  { name: "star-source-crlf", family: familyNames[4], source: "export//a\r\n*//b\r\nfrom//c\r\n\"./module.mjs\";", expected: true },
  { name: "star-source-near", family: familyNames[4], source: "export function value() {}", expected: false },
  { name: "dynamic-direct", family: familyNames[5], source: "const value = import(\"./module.mjs\");", expected: true },
  { name: "dynamic-single-quote", family: familyNames[5], source: "const value = import(" + apostrophe + "./module.mjs" + apostrophe + ");", expected: true },
  { name: "dynamic-tab", family: familyNames[5], source: "const value = import\t(\"./module.mjs\");", expected: true },
  { name: "dynamic-block", family: familyNames[5], source: "const value = import/*a*/(\"./module.mjs\");", expected: true },
  { name: "dynamic-lf", family: familyNames[5], source: "const value = import//a\n(\"./module.mjs\");", expected: true },
  { name: "dynamic-crlf", family: familyNames[5], source: "const value = import//a\r\n(\"./module.mjs\");", expected: true },
  { name: "dynamic-meta-near", family: familyNames[5], source: "const value = import.meta.url;", expected: false },
  { name: "dynamic-dollar-prefix-near", family: familyNames[5], source: "$import(\"./module.mjs\");", expected: false },
  { name: "dynamic-dollar-suffix-near", family: familyNames[5], source: "import$(\"./module.mjs\");", expected: false },
  { name: "commonjs-require-direct", family: familyNames[6], source: "const value = require(\"module\");", expected: true },
  { name: "commonjs-require-single-quote", family: familyNames[6], source: "const value = require(" + apostrophe + "module" + apostrophe + ");", expected: true },
  { name: "commonjs-require-tab", family: familyNames[6], source: "const value = require\t(\"module\");", expected: true },
  { name: "commonjs-require-block", family: familyNames[6], source: "const value = require/*a*/(\"module\");", expected: true },
  { name: "commonjs-require-lf", family: familyNames[6], source: "const value = require//a\n(\"module\");", expected: true },
  { name: "commonjs-require-crlf", family: familyNames[6], source: "const value = require//a\r\n(\"module\");", expected: true },
  { name: "environment-process", family: familyNames[6], source: "const value = process.env;", expected: true },
  { name: "environment-import-meta", family: familyNames[6], source: "const value = import.meta.env;", expected: true },
  { name: "environment-dotenv", family: familyNames[6], source: "const value = \"dotenv\";", expected: true },
  { name: "environment-dotenv-bare", family: familyNames[6], source: "dotenv;", expected: true },
  { name: "environment-dotenv-member", family: familyNames[6], source: "dotenv.config();", expected: true },
  { name: "environment-database-url", family: familyNames[6], source: "const value = \"DATABASE_URL\";", expected: true },
  { name: "environment-database-url-bare", family: familyNames[6], source: "DATABASE_URL;", expected: true },
  { name: "commonjs-requirement-near", family: familyNames[6], source: "const requirement = true;", expected: false },
  { name: "commonjs-require-dollar-prefix-near", family: familyNames[6], source: "$require(\"module\");", expected: false },
  { name: "commonjs-require-dollar-suffix-near", family: familyNames[6], source: "require$(\"module\");", expected: false },
  { name: "environment-processor-near", family: familyNames[6], source: "const processor = {};", expected: false },
  { name: "environment-process-dollar-prefix-near", family: familyNames[6], source: "$process.env;", expected: false },
  { name: "environment-process-dollar-suffix-near", family: familyNames[6], source: "process$.env;", expected: false },
  { name: "environment-import-meta-near", family: familyNames[6], source: "const value = import.meta.url;", expected: false },
  { name: "environment-import-dollar-prefix-near", family: familyNames[6], source: "$import.meta.env;", expected: false },
  { name: "environment-import-dollar-suffix-near", family: familyNames[6], source: "import$.meta.env;", expected: false },
  { name: "environment-dotenv-near", family: familyNames[6], source: "const value = \"dotenvSafe\";", expected: false },
  { name: "environment-dotenv-dollar-prefix-near", family: familyNames[6], source: "$dotenv;", expected: false },
  { name: "environment-dotenv-dollar-suffix-near", family: familyNames[6], source: "dotenv$;", expected: false },
  { name: "environment-database-url-near", family: familyNames[6], source: "const value = \"DATABASE_URL_SAFE\";", expected: false },
  { name: "environment-database-url-dollar-prefix-near", family: familyNames[6], source: "$DATABASE_URL;", expected: false },
  { name: "environment-database-url-dollar-suffix-near", family: familyNames[6], source: "DATABASE_URL$;", expected: false }
];

function fixtureSource(marker, positive) {
  const near = marker.name.replace(/\/$/, "") + "Near";
  if (marker.kind === "call") return (positive ? marker.name : near) + "();";
  if (marker.kind === "call-or-construct") return (positive ? marker.name : near) + "();";
  if (marker.kind === "member") return (positive ? marker.name : near) + ".value;";
  if (marker.kind === "string-exact") return "const value = \"" + (positive ? marker.name : near) + "\";";
  if (marker.kind === "string-part") return "const value = \"prefix " + (positive ? marker.name : near) + " suffix\";";
  return "const " + (positive ? marker.name : near) + " = 1;";
}

function tokenFixtures(family, marker) {
  if (!["module", "module-prefix"].includes(marker.kind)) return [
    { name: family.name + "-" + marker.name + "-positive", family: family.name, marker: marker.name, source: fixtureSource(marker, true), expected: true },
    { name: family.name + "-" + marker.name + "-near-miss", family: family.name, marker: marker.name, source: fixtureSource(marker, false), expected: false }
  ];
  const specifier = marker.kind === "module-prefix" ? marker.name + "identity" : marker.name;
  const near = marker.kind === "module-prefix" ? "@azures/identity" : marker.name + "Near";
  return [
    { name: family.name + "-" + marker.name + "-double-import", family: family.name, marker: marker.name, source: "import \"" + specifier + "\";", expected: true },
    { name: family.name + "-" + marker.name + "-single-import", family: family.name, marker: marker.name, source: "import " + apostrophe + specifier + apostrophe + ";", expected: true },
    { name: family.name + "-" + marker.name + "-export-from", family: family.name, marker: marker.name, source: "export { value } from \"" + specifier + "\";", expected: true },
    { name: family.name + "-" + marker.name + "-import-near-miss", family: family.name, marker: marker.name, source: "import \"" + near + "\";", expected: false },
    { name: family.name + "-" + marker.name + "-double-ordinary-string", family: family.name, marker: marker.name, source: "const label = \"" + specifier + "\";", expected: false },
    { name: family.name + "-" + marker.name + "-single-ordinary-string", family: family.name, marker: marker.name, source: "const label = " + apostrophe + specifier + apostrophe + ";", expected: false },
    { name: family.name + "-" + marker.name + "-comment", family: family.name, marker: marker.name, source: "// " + specifier + "\nconst label = 1;", expected: false },
    { name: family.name + "-" + marker.name + "-template", family: family.name, marker: marker.name, source: "const label = " + templateQuote + specifier + templateQuote + ";", expected: false }
  ];
}

const tokenRows = tokenFamilies.flatMap((family) => family.markers.flatMap((marker) => tokenFixtures(family, marker)));

function dollarBoundarySource(marker, prefix) {
  const name = prefix ? "$" + marker.name : marker.name + "$";
  if (marker.kind === "call" || marker.kind === "call-or-construct") return name + "();";
  if (marker.kind === "member") return name + ".value;";
  return "const " + name + " = 1;";
}

const identifierMarkers = tokenFamilies.flatMap((family) => family.markers.filter((marker) => ["identifier", "call", "call-or-construct", "member"].includes(marker.kind)).map((marker) => ({ family, marker })));
const dollarBoundaryRows = identifierMarkers.flatMap(({ family, marker }) => [
  { name: family.name + "-" + marker.name + "-dollar-prefix", family: family.name, source: dollarBoundarySource(marker, true) },
  { name: family.name + "-" + marker.name + "-dollar-suffix", family: family.name, source: dollarBoundarySource(marker, false) }
]);
const functionConstructionRows = [
  { name: "function-construction", source: "new Function();", expected: true },
  { name: "function-construction-dollar-prefix", source: "new $Function();", expected: false },
  { name: "function-construction-dollar-suffix", source: "new Function$();", expected: false }
];

function assertSyntax(source) {
  execFileSync(process.execPath, ["--check", "--input-type=module"], { input: source, stdio: ["pipe", "pipe", "pipe"] });
}

function countMatches(source, matcher) {
  let count = 0;
  let remaining = source;
  let match = matcher.exec(remaining);
  while (match) {
    count += 1;
    remaining = remaining.slice(match.index + match[0].length);
    match = matcher.exec(remaining);
  }
  return count;
}

describe("Azure release workload identity static hardening", () => {
  test("locks the exact nonempty registry and non-stateful matchers", () => {
    expect(productionSource.length).toBeGreaterThan(0);
    expect(testSource.length).toBeGreaterThan(0);
    expect(families.map(({ name }) => name)).toStrictEqual(familyNames);
    expect(families).toHaveLength(17);
    expect(new Set(familyNames).size).toBe(17);
    expect(tokenFamilies.flatMap(({ markers }) => markers)).toHaveLength(105);
    for (const family of families) {
      expect(family.name.length).toBeGreaterThan(0);
      expect(family.matcher.global).toBe(false);
      expect(family.matcher.sticky).toBe(false);
    }
    for (const family of tokenFamilies) {
      expect(family.markers.length).toBeGreaterThan(0);
      expect(new Set(family.markers.map(({ name }) => name)).size).toBe(family.markers.length);
    }
  });

  test("proves the exact permitted module surface", () => {
    expect(countMatches(productionSource, exactProviderImportMatcher)).toBe(1);
    expect(countMatches(productionSource, exactLocalStatusExportMatcher)).toBe(1);
    expect(additionalStaticImportMatcher.test(productionSource)).toBe(false);
    expect(namedSourceReexportMatcher.test(productionSource)).toBe(false);
    expect(starSourceReexportMatcher.test(productionSource)).toBe(false);
    expect(dynamicImportMatcher.test(productionSource)).toBe(false);
    expect(commonjsEnvironmentMatcher.test(productionSource)).toBe(false);
    for (const family of tokenFamilies) {
      expect(family.matcher.test(productionSource)).toBe(false);
    }
  });

  test("binds every structural fixture and validates ESM syntax without execution", () => {
    expect(structuralRows).toHaveLength(99);
    expect(new Set(structuralRows.map(({ name }) => name)).size).toBe(99);
    expect(new Set(structuralRows.map(({ family }) => family)).size).toBe(7);
    for (const row of structuralRows) {
      assertSyntax(row.source);
      const family = families.find(({ name }) => name === row.family);
      expect(family.matcher.test(row.source), row.name).toBe(row.expected);
      if (row.name.endsWith("asi-next")) {
        expect(family.matcher.exec(row.source)[0].includes("const next"), row.name).toBe(false);
      }
    }
    for (const family of structuralFamilies) {
      const rows = structuralRows.filter((row) => row.family === family.name);
      expect(rows.some(({ expected }) => expected)).toBe(true);
      expect(rows.some(({ expected }) => !expected)).toBe(true);
    }
  });

  test("binds every locked token marker to one positive and near miss", () => {
    expect(tokenRows).toHaveLength(300);
    expect(new Set(tokenRows.map(({ name }) => name)).size).toBe(300);
    for (const row of tokenRows) {
      assertSyntax(row.source);
      const family = tokenFamilies.find(({ name }) => name === row.family);
      expect(family.matcher.test(row.source), row.name).toBe(row.expected);
    }
    for (const family of tokenFamilies) {
      for (const marker of family.markers) {
        const rows = tokenRows.filter((row) => row.family === family.name && row.marker === marker.name);
        const expected = ["module", "module-prefix"].includes(marker.kind) ? [true, true, true, false, false, false, false, false] : [true, false];
        expect(rows.map((row) => row.expected)).toStrictEqual(expected);
      }
    }
  });

  test("uses JavaScript identifier boundaries and blocks both Function forms", () => {
    expect(identifierMarkers).toHaveLength(81);
    expect(dollarBoundaryRows).toHaveLength(162);
    expect(new Set(dollarBoundaryRows.map(({ name }) => name)).size).toBe(162);
    for (const row of dollarBoundaryRows) {
      assertSyntax(row.source);
      const family = tokenFamilies.find(({ name }) => name === row.family);
      expect(family.matcher.test(row.source), row.name).toBe(false);
    }
    expect(functionConstructionRows).toHaveLength(3);
    const matcher = tokenFamilies.find(({ name }) => name === "code-generation").matcher;
    for (const row of functionConstructionRows) {
      assertSyntax(row.source);
      expect(matcher.test(row.source), row.name).toBe(row.expected);
    }
  });

  test("contains neither assessor and locks both exact caller sets", () => {
    expect(testSource.includes(providerAssessorName)).toBe(false);
    expect(testSource.includes(workloadAssessorName)).toBe(false);
    const cwd = new URL("../../", import.meta.url);
    const providerOutput = execFileSync("git", ["grep", "-l", providerAssessorName], { cwd, encoding: "utf8" });
    const workloadOutput = execFileSync("git", ["grep", "-l", workloadAssessorName], { cwd, encoding: "utf8" });
    expect(providerOutput.trim().split("\n").sort()).toStrictEqual(["scripts/release/azure-release-provider-identity-core.test.mjs", "scripts/release/azure-release-provider-identity-hardening.test.mjs", "scripts/release/azure-release-provider-identity.mjs", "scripts/release/azure-release-workload-identity.mjs"]);
    expect(workloadOutput.trim().split("\n").sort()).toStrictEqual(["scripts/release/azure-release-workload-identity-core.test.mjs", "scripts/release/azure-release-workload-identity-hardening.test.mjs", "scripts/release/azure-release-workload-identity.mjs"]);
  });
});
