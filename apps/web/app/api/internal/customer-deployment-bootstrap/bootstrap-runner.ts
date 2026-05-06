import { execFile } from "node:child_process";
import path from "node:path";

function rootDir() {
  return process.cwd().endsWith(`${path.sep}apps${path.sep}web`)
    ? path.resolve(process.cwd(), "..", "..")
    : process.cwd();
}

export async function runStableClientSeed(config: Record<string, unknown>, env: Record<string, string>) {
  const root = rootDir();
  const seedScript = path.join(root, "scripts", "seed-client-stable.mjs");

  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [seedScript], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        CLIENT_SEED_CONFIG_JSON: JSON.stringify(config),
      },
      timeout: 120_000,
      windowsHide: true,
    }, (error) => {
      if (error) {
        reject(new Error("Stable client seed failed."));
        return;
      }
      resolve();
    });
  });
}
