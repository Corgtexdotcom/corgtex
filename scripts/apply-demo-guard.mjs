import fs from 'fs';
import path from 'path';

const files = [
  'apps/web/app/workspaces/[workspaceId]/actions.ts',
  'apps/web/app/workspaces/[workspaceId]/brain/actions.ts'
];

for (const file of files) {
  const filepath = path.resolve(file);
  let content = fs.readFileSync(filepath, 'utf8');

  // Add import if not present
  if (!content.includes('enforceDemoGuard')) {
    content = 'import { enforceDemoGuard } from "@/lib/demo-guard";\n' + content;
  }

  // Define regex to match `export async function nameAction(formData: FormData) {`
  const regex = /(export async function [a-zA-Z]+Action\(\s*formData:\s*FormData\s*\)\s*\{)/g;
  
  content = content.replace(regex, (match) => {
    // Basic injection: Extract workspaceId and enforce the guard
    return match + '\n  const _demoGuardWsId = formData.get("workspaceId") as string;\n  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);\n';
  });

  fs.writeFileSync(filepath, content);
  console.log(`Updated ${file}`);
}
