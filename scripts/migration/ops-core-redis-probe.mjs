import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { runRedisTargetProbe } from "./ops-core-redis-gate.mjs";

export const REDIS_PROBE_PREFIX = "CORGTEX_REDIS_PROBE_V1 ";
// Hash actual image files, independently of the challenge. The pinned image
// additionally binds node_modules and this bootstrap before it is executed.
export async function redisProbeBuildSha256() {
  const files = [];
  for (const name of ["ops-core-archive.mjs", "ops-core-redis-gate.mjs", "ops-core-redis-probe.mjs"]) {
    files.push({ name, sha256: createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex") });
  }
  return archiveEvidenceHash(files);
}
export async function runRedisProbeCli({ env = process.env, write = text => process.stdout.write(text) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110_000);
  try {
    const parse = name => {
      if (typeof env[name] !== "string" || Buffer.byteLength(env[name]) > 16_384) throw new Error();
      return JSON.parse(env[name]);
    };
    const identity = parse("CORGTEX_REDIS_PROBE_IDENTITY");
    if (identity.probeSha256 !== await redisProbeBuildSha256()) throw new Error();
    const receipt = await runRedisTargetProbe({ binding: parse("CORGTEX_REDIS_TARGET"),
      challenge: parse("CORGTEX_REDIS_CHALLENGE"), identity,
      credentials: { password: env.REDIS_PROBE_PASSWORD, tlsCa: null }, signal: controller.signal });
    write(`${REDIS_PROBE_PREFIX}${JSON.stringify(receipt)}\n`);
    // ARM may return whole-second endTime. Keep the successful container alive
    // long enough for its reported end to enclose the millisecond observation.
    await delay(1100, undefined, { signal: controller.signal });
    return true;
  } catch { write("CORGTEX_REDIS_PROBE_FAILED\n"); return false; }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runRedisProbeCli() ? 0 : 1;
}
