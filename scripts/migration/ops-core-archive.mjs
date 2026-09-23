import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);
const MAGIC = Buffer.from("CORGTEX-PG1\0");
const HEADER_BYTES = MAGIC.length + 12;
const HASH = /^[a-f0-9]{64}$/;
class ArchiveError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.stage = details.stage ?? null;
    this.reason = details.reason ?? null;
    Object.freeze(this);
  }
}
const fail = (code) => { throw new ArchiveError(code); };
export const postgresArchiveDiagnostic = (error) => error instanceof ArchiveError
  ? { code: error.code, operationStage: error.stage, reason: error.reason } : null;
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const archiveEvidenceHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

function validateBinding(binding) {
  if (!binding || Object.keys(binding).sort().join(",") !== "domain,intentSha256,operationId,sourceFenceSha256,sourceRef,targetRef"
    || !["ops", "core"].includes(binding.domain) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.operationId)
    || !HASH.test(binding.intentSha256) || !HASH.test(binding.sourceFenceSha256)
    || !/^sha256:[a-f0-9]{16}$/.test(binding.sourceRef) || !/^sha256:[a-f0-9]{16}$/.test(binding.targetRef)
    || binding.sourceRef === binding.targetRef) fail("ARCHIVE_BINDING_INVALID");
}

export function validateArchiveKeyVersion(keyVersion, vaultName) {
  if (!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) fail("ARCHIVE_VAULT_INVALID");
  let url;
  try { url = new URL(keyVersion); } catch { fail("ARCHIVE_KEY_VERSION_INVALID"); }
  if (url.origin !== `https://${vaultName.toLowerCase()}.vault.azure.net`
    || !/^\/secrets\/[a-zA-Z0-9-]{1,127}\/[a-f0-9]{32}$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash || url.href !== keyVersion) fail("ARCHIVE_KEY_VERSION_INVALID");
  return keyVersion;
}

/** Reads an already-retained version through the operator's Azure identity.
 * Secret bytes never enter argv, output, an exception, or the archive manifest.
 */
export async function readArchiveKeyVersion(keyVersion, vaultName) {
  validateArchiveKeyVersion(keyVersion, vaultName);
  try {
    const { stdout } = await execFileAsync("az", ["keyvault", "secret", "show", "--id", keyVersion,
      "--query", "value", "--output", "tsv", "--only-show-errors"], { timeout: 30_000, maxBuffer: 8192 });
    const text = stdout.trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) fail("ARCHIVE_KEY_INVALID");
    const key = Buffer.from(text, "base64");
    if (key.length !== 32 || key.toString("base64") !== text) fail("ARCHIVE_KEY_INVALID");
    return key;
  } catch { fail("ARCHIVE_KEY_UNAVAILABLE"); }
}

function validKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail("ARCHIVE_KEY_INVALID");
  return key;
}

async function decryptAndVerify(store, manifest, key, onPlaintext = async () => {}) {
  const cipherHash = createHash("sha256");
  const plainHash = createHash("sha256");
  const stream = await store.read(manifest.archiveKey);
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher;
  let cipherBytes = 0;
  let plainBytes = 0;
  const consume = async (chunk) => {
    plainBytes += chunk.length;
    if (plainBytes > manifest.plaintextBytes) fail("ARCHIVE_PLAINTEXT_SIZE_INVALID");
    plainHash.update(chunk);
    await onPlaintext(chunk);
  };
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) fail("ARCHIVE_STREAM_INVALID");
    cipherBytes += chunk.byteLength;
    if (cipherBytes > manifest.ciphertextBytes) fail("ARCHIVE_CIPHERTEXT_SIZE_INVALID");
    cipherHash.update(chunk);
    let current = Buffer.from(chunk);
    if (!decipher) {
      const take = Math.min(HEADER_BYTES - header.length, current.length);
      header = Buffer.concat([header, current.subarray(0, take)]);
      current = current.subarray(take);
      if (header.length < HEADER_BYTES) continue;
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) fail("ARCHIVE_HEADER_INVALID");
      decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
      decipher.setAAD(Buffer.from(canonical(manifest.aad)));
    }
    const combined = Buffer.concat([tail, current]);
    const cipherEnd = Math.max(0, combined.length - 16);
    if (cipherEnd) await consume(decipher.update(combined.subarray(0, cipherEnd)));
    tail = combined.subarray(cipherEnd);
  }
  if (!decipher || tail.length !== 16 || cipherBytes !== manifest.ciphertextBytes) fail("ARCHIVE_TRUNCATED");
  decipher.setAuthTag(tail);
  await consume(decipher.final());
  if (plainBytes !== manifest.plaintextBytes || plainHash.digest("hex") !== manifest.plaintextSha256
    || cipherHash.digest("hex") !== manifest.ciphertextSha256) fail("ARCHIVE_DIGEST_MISMATCH");
}

/** Retains encrypted pg_dump and frozen evidence create-only, then re-reads the
 * versioned key and verifies downloaded bytes before recording a usable manifest.
 */
export async function retainPostgresArchive({ dumpFile, sourceEvidence, sourceSequences, binding: suppliedBinding,
  keyVersion, vaultName, store, assertOwned, signal, maxBytes, resolveKey = readArchiveKeyVersion }) {
  const binding = structuredClone(suppliedBinding);
  validateBinding(binding);
  validateArchiveKeyVersion(keyVersion, vaultName);
  if (typeof assertOwned !== "function" || !signal || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("ARCHIVE_CUSTODY_REQUIRED");
  if (!sourceEvidence || typeof sourceEvidence !== "object" || Array.isArray(sourceEvidence)
    || !Array.isArray(sourceSequences)) fail("ARCHIVE_SOURCE_EVIDENCE_REQUIRED");
  const evidence = { sourceEvidence: structuredClone(sourceEvidence), sourceSequences: structuredClone(sourceSequences) };
  const aad = { formatVersion: 1, binding, evidenceSha256: archiveEvidenceHash(evidence), keyVersion };
  const check = async () => { signal.throwIfAborted(); await assertOwned(); signal.throwIfAborted(); };
  const archiveKey = `${binding.operationId}.pg.aesgcm`;
  let file;
  let encryptionKey;
  let recoveryKey;
  let stage = "OPEN_SOURCE";
  try {
    await check();
    await store.assertPrivate();
    encryptionKey = validKey(await resolveKey(keyVersion, vaultName));
    file = await open(dumpFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes || (before.mode & 0o077) !== 0) fail("ARCHIVE_SOURCE_FILE_INVALID");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(canonical(aad)));
    const cipherHash = createHash("sha256");
    const plainHash = createHash("sha256");
    let plaintextBytes = 0;
    let ciphertextBytes = 0;
    const recordCipher = (chunk) => { ciphertextBytes += chunk.length; cipherHash.update(chunk); return chunk; };
    const encrypted = (async function* () {
      yield recordCipher(Buffer.concat([MAGIC, nonce]));
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        signal.throwIfAborted();
        plaintextBytes += chunk.length;
        if (plaintextBytes > before.size) fail("ARCHIVE_SOURCE_CHANGED");
        plainHash.update(chunk);
        yield recordCipher(cipher.update(chunk));
      }
      const after = await file.stat();
      if (plaintextBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("ARCHIVE_SOURCE_CHANGED");
      yield recordCipher(cipher.final());
      yield recordCipher(cipher.getAuthTag());
    })();
    await check();
    stage = "UPLOAD_CIPHERTEXT";
    await store.createOnly(archiveKey, encrypted, signal);
    await check();
    encryptionKey.fill(0);
    const manifestBody = { formatVersion: 1, aad, archiveKey, storeId: store.identity,
      plaintextBytes, plaintextSha256: plainHash.digest("hex"), ciphertextBytes, ciphertextSha256: cipherHash.digest("hex") };
    const manifest = { ...manifestBody, sha256: archiveEvidenceHash(manifestBody) };
    stage = "VERIFY_RECOVERY";
    recoveryKey = validKey(await resolveKey(keyVersion, vaultName));
    await decryptAndVerify(store, manifest, recoveryKey);
    await check();
    await store.assertPrivate();
    stage = "RETAIN_EVIDENCE";
    await store.createOnly(`${binding.operationId}.evidence.json`, Readable.from([Buffer.from(canonical(evidence))]), signal);
    await check();
    stage = "RETAIN_MANIFEST";
    await store.createOnly(`${binding.operationId}.manifest.json`, Readable.from([Buffer.from(canonical(manifest))]), signal);
    await check();
    return manifest;
  } catch (error) {
    // An upload may have committed. Keep every retained object and reconcile;
    // neither overwrite/retry nor source recovery follows from a missing receipt.
    throw new ArchiveError("ARCHIVE_RETENTION_RECONCILE_REQUIRED", { stage,
      reason: error instanceof ArchiveError ? error.code : "UNCLASSIFIED_FAILURE" });
  } finally {
    encryptionKey?.fill(0);
    recoveryKey?.fill(0);
    await file?.close().catch(() => {});
  }
}

/** Writes only a new private recovery file. Authentication/digest verification
 * completes before the caller may use it for pg_restore. Failure removes this
 * call's partial file, never any preexisting path or retained cloud archive.
 */
export async function recoverPostgresArchive({ manifest: suppliedManifest, expectedBinding, store, outputFile,
  vaultName, maxBytes, signal, resolveKey = readArchiveKeyVersion }) {
  const manifest = structuredClone(suppliedManifest);
  validateBinding(expectedBinding);
  const { sha256, ...body } = manifest;
  if (!HASH.test(sha256) || archiveEvidenceHash(body) !== sha256 || manifest.formatVersion !== 1
    || canonical(manifest.aad?.binding) !== canonical(expectedBinding) || manifest.storeId !== store.identity
    || manifest.archiveKey !== `${expectedBinding.operationId}.pg.aesgcm`
    || !HASH.test(manifest.plaintextSha256) || !HASH.test(manifest.ciphertextSha256)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(manifest.plaintextBytes)
    || manifest.plaintextBytes < 1 || manifest.plaintextBytes > maxBytes
    || manifest.ciphertextBytes !== manifest.plaintextBytes + HEADER_BYTES + 16) fail("ARCHIVE_MANIFEST_INVALID");
  validateArchiveKeyVersion(manifest.aad.keyVersion, vaultName);
  let file;
  let key;
  let verified = false;
  try {
    signal.throwIfAborted();
    await store.assertPrivate();
    key = validKey(await resolveKey(manifest.aad.keyVersion, vaultName));
    file = await open(outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await decryptAndVerify(store, manifest, key, async (chunk) => {
      signal.throwIfAborted();
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) fail("ARCHIVE_RECOVERY_WRITE_FAILED");
        offset += bytesWritten;
      }
    });
    await file.sync();
    signal.throwIfAborted();
    verified = true;
    return { manifestSha256: manifest.sha256, plaintextSha256: manifest.plaintextSha256, bytes: manifest.plaintextBytes };
  } catch { fail("ARCHIVE_RECOVERY_FAILED"); }
  finally {
    key?.fill(0);
    if (file) {
      const owned = await file.stat().catch(() => null);
      await file.close().catch(() => {});
      if (!verified) {
        const { lstat, unlink } = await import("node:fs/promises");
        const current = await lstat(outputFile).catch(() => null);
        if (owned && current && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) {
          await unlink(outputFile).catch(() => {});
        }
      }
    }
  }
}

export function azureArchiveStore(container) {
  const url = new URL(container.url);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) fail("ARCHIVE_CONTAINER_INVALID");
  return {
    identity: createHash("sha256").update(`${url.origin}${url.pathname.replace(/\/+$/, "")}`).digest("hex"),
    async assertPrivate() {
      const policy = await container.getAccessPolicy();
      if (policy.blobPublicAccess !== undefined) fail("ARCHIVE_CONTAINER_PUBLIC");
    },
    async createOnly(key, body, signal) {
      await container.getBlockBlobClient(key).uploadStream(Readable.from(body), 4 * 1024 * 1024, 1, {
        abortSignal: signal, conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      });
    },
    async read(key) {
      const result = await container.getBlobClient(key).download();
      if (!result.readableStreamBody) fail("ARCHIVE_BODY_MISSING");
      return result.readableStreamBody;
    },
  };
}
