import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  "apps/web/lib/components",
  "apps/web/app/[locale]/workspaces/[workspaceId]",
];

const INLINE_STYLE = /style=\{\{/g;
const RAW_TAILWIND_COLOR = /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const SHARED_PRIMITIVE_IMPORT = /ControlPrimitives|DataTable|WorkItemControls|WorkItemTable|WorkItemKanbanBoard/g;

function listFiles(root) {
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot)) return [];
  const entries = fs.readdirSync(absRoot, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(absRoot, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    if (!entry.name.endsWith(".tsx")) return [];
    return [entryPath];
  });
}

function countMatches(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

const reports = ROOTS
  .flatMap(listFiles)
  .map((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    return {
      filePath,
      inlineStyles: countMatches(source, INLINE_STYLE),
      rawColors: countMatches(source, RAW_TAILWIND_COLOR),
      sharedImports: countMatches(source, SHARED_PRIMITIVE_IMPORT),
    };
  })
  .filter((entry) => entry.inlineStyles > 0 || entry.rawColors > 0)
  .sort((left, right) => (right.inlineStyles + right.rawColors) - (left.inlineStyles + left.rawColors));

console.log("UI spine drift report (advisory only)");
console.log("Use shared primitives or promote better local exceptions into the spine before broad reuse.\n");

if (reports.length === 0) {
  console.log("No inline styles or raw Tailwind color utilities found in scanned workspace UI files.");
  process.exit(0);
}

for (const entry of reports.slice(0, 20)) {
  console.log([
    path.relative(process.cwd(), entry.filePath),
    `inlineStyles=${entry.inlineStyles}`,
    `rawColorClasses=${entry.rawColors}`,
    `sharedPrimitiveRefs=${entry.sharedImports}`,
  ].join("  "));
}

if (reports.length > 20) {
  console.log(`\n${reports.length - 20} additional files omitted.`);
}

console.log("\nThis report does not fail CI. It is a planning aid for UI spine migrations.");
