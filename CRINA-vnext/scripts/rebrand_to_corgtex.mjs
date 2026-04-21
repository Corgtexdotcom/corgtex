import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage']);
const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.json', '.md', '.mts', '.mjs', '.cjs']);

function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!EXCLUDE_DIRS.has(file)) {
        walkDir(fullPath, callback);
      }
    } else {
      const ext = path.extname(file);
      if (TARGET_EXTENSIONS.has(ext)) {
        callback(fullPath);
      }
    }
  }
}

let changedFilesCount = 0;

walkDir(ROOT_DIR, (filePath) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  let newContent = content;

  // Replace @corgtex/ with @corgtex/ globally
  newContent = newContent.replace(/@crina\//g, '@corgtex/');

  // If this is the root package.json, also update the main project name
  if (filePath === path.join(ROOT_DIR, 'package.json')) {
    newContent = newContent.replace(/"name":\s*"crina-vnext"/, '"name": "corgtex"');
    newContent = newContent.replace(/"name":\s*"crina"/, '"name": "corgtex"');
  }

  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, 'utf-8');
    console.log(`Updated: ${path.relative(ROOT_DIR, filePath)}`);
    changedFilesCount++;
  }
});

console.log(`\n✅ Renamed @corgtex/* to @corgtex/* in ${changedFilesCount} files.`);
console.log(`\nNext steps:
1. Run \`npm install\` to update lockfiles.
2. Run \`npm run check\` to verify.
3. Commit and push the PR.`);
