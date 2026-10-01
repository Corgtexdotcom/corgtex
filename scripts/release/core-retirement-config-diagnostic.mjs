import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { canonical, identityHash, sha256 } from "../core-baseline-common.mjs";

const KIND = "core-retirement-private-config-diagnostic";
const LIMIT = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = () => { throw new Error("CORE_RETIREMENT_CONFIG_DIAGNOSTIC_INVALID"); };
const need = value => { if (!value) fail(); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const pointer = key => key.replace(/~/g, "~0").replace(/\//g, "~1");
const jsonBytes = value => { const bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= LIMIT); return bytes; };

/** Paths and key names are private too: this map must only leave the runner encrypted. */
export function privateConfigurationFingerprints(value) {
  const result = Object.create(null);
  const parents = new Set();
  let nodes = 0;
  const visit = (item, path, depth) => {
    need(depth <= 64 && ++nodes <= 10000);
    const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    if (type === "object" || type === "array") {
      need(!parents.has(item)); parents.add(item);
      if (type === "object") {
        need(record(item) && Object.getOwnPropertySymbols(item).length === 0);
        const keys = Object.keys(item).sort();
        result[path] = { type, keys };
        for (const key of keys) visit(item[key], `${path}/${pointer(key)}`, depth + 1);
      } else {
        need(Object.keys(item).length === item.length);
        result[path] = { type, length: item.length };
        for (let i = 0; i < item.length; i++) { need(Object.hasOwn(item, i)); visit(item[i], `${path}/${i}`, depth + 1); }
      }
      parents.delete(item);
    } else {
      need(["null", "string", "number", "boolean", "undefined"].includes(type)
        && (type !== "number" || Number.isFinite(item)));
      result[path] = type === "undefined" ? { type } : { type, sha256: identityHash(item) };
    }
  };
  visit(value, "", 0); jsonBytes(result); return result;
}

function validateFingerprints(map) {
  need(record(map) && Object.hasOwn(map, "") && Object.keys(map).length <= 10000);
  const visited = new Set();
  const visit = (path, depth) => {
    need(depth <= 64 && Object.hasOwn(map, path)); visited.add(path);
    const entry = map[path]; need(record(entry));
    if (entry.type === "object") {
      need(exact(entry, ["type", "keys"]) && Array.isArray(entry.keys) && entry.keys.length <= 10000
        && entry.keys.every(key => typeof key === "string")
        && new Set(entry.keys).size === entry.keys.length
        && canonical(entry.keys) === canonical([...entry.keys].sort()));
      for (const key of entry.keys) visit(`${path}/${pointer(key)}`, depth + 1);
    } else if (entry.type === "array") {
      need(exact(entry, ["type", "length"]) && Number.isSafeInteger(entry.length) && entry.length >= 0 && entry.length <= 10000);
      for (let i = 0; i < entry.length; i++) visit(`${path}/${i}`, depth + 1);
    } else if (entry.type === "undefined") need(exact(entry, ["type"]));
    else need(["null", "string", "number", "boolean"].includes(entry.type) && exact(entry, ["type", "sha256"]) && HASH.test(entry.sha256));
  };
  visit("", 0); need(visited.size === Object.keys(map).length);
}

function validateBinding(binding) {
  need(exact(binding, ["caseSha256", "workflowSha", "runId", "runAttempt", "target", "querySha256", "expectedConfigSha256", "observedConfigSha256", "capturedAt"]));
  for (const field of ["caseSha256", "querySha256", "expectedConfigSha256", "observedConfigSha256"]) need(typeof binding[field] === "string" && HASH.test(binding[field]));
  need(typeof binding.workflowSha === "string" && /^[a-f0-9]{40}$/.test(binding.workflowSha));
  for (const field of ["runId", "runAttempt"]) need((Number.isSafeInteger(binding[field]) && binding[field] > 0)
    || (typeof binding[field] === "string" && /^[1-9][0-9]{0,19}$/.test(binding[field])));
  need(exact(binding.target, ["projectId", "environmentId", "webServiceId", "workerServiceId"])
    && Object.values(binding.target).every(value => typeof value === "string" && UUID.test(value)));
  need(typeof binding.capturedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(binding.capturedAt)
    && Number.isFinite(Date.parse(binding.capturedAt)));
}
function validateReport(report) {
  need(exact(report, ["binding", "fingerprints"])); validateBinding(report.binding); validateFingerprints(report.fingerprints); jsonBytes(report);
}
function recipient(publicKey) {
  need(publicKey.asymmetricKeyType === "rsa" && publicKey.asymmetricKeyDetails.modulusLength >= 3072
    && publicKey.asymmetricKeyDetails.modulusLength <= 8192);
  return sha256(publicKey.export({ type: "spki", format: "pem" }));
}
const aad = envelope => Buffer.from(canonical({ kind: envelope.kind, schemaVersion: envelope.schemaVersion,
  recipientSha256: envelope.recipientSha256, binding: envelope.binding }));
function decode(value, length) {
  need(typeof value === "string" && value.length > 0 && value.length <= LIMIT && /^[A-Za-z0-9+/]+={0,2}$/.test(value));
  const bytes = Buffer.from(value, "base64"); need(bytes.toString("base64") === value && (length === undefined || bytes.length === length)); return bytes;
}
function validateEnvelope(envelope) {
  need(exact(envelope, ["kind", "schemaVersion", "recipientSha256", "binding", "wrappedKey", "iv", "tag", "ciphertext"]));
  jsonBytes(envelope); need(envelope.kind === KIND && envelope.schemaVersion === 1 && typeof envelope.recipientSha256 === "string" && HASH.test(envelope.recipientSha256));
  validateBinding(envelope.binding);
  decode(envelope.iv, 12); decode(envelope.tag, 16); decode(envelope.ciphertext);
  need(decode(envelope.wrappedKey).length >= 384 && decode(envelope.wrappedKey).length <= 1024);
}

export function sealConfigurationDiagnostic(report, publicKeyPem) {
  let key;
  try {
    validateReport(report);
    need(typeof publicKeyPem === "string" && publicKeyPem.length <= 16384 && publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
    const publicKey = createPublicKey(publicKeyPem);
    const envelope = { kind: KIND, schemaVersion: 1, recipientSha256: recipient(publicKey), binding: structuredClone(report.binding) };
    key = randomBytes(32); const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(envelope));
    const ciphertext = Buffer.concat([cipher.update(jsonBytes(report)), cipher.final()]);
    Object.assign(envelope, { wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    validateEnvelope(envelope); return envelope;
  } catch { fail(); } finally { key?.fill(0); }
}

/** Local owner only. expectedBinding, when supplied, must match every bound field. */
export function openConfigurationDiagnostic(envelope, privateKeyPem, expectedBinding) {
  let key;
  try {
    validateEnvelope(envelope);
    const privateKey = createPrivateKey(privateKeyPem), publicKey = createPublicKey(privateKey);
    need(recipient(publicKey) === envelope.recipientSha256);
    if (expectedBinding !== undefined) { validateBinding(expectedBinding); need(canonical(expectedBinding) === canonical(envelope.binding)); }
    need(decode(envelope.wrappedKey).length === publicKey.asymmetricKeyDetails.modulusLength / 8);
    key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, decode(envelope.wrappedKey)); need(key.length === 32);
    const decipher = createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12));
    decipher.setAAD(aad(envelope)); decipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]); need(plaintext.length <= LIMIT);
    const report = JSON.parse(plaintext.toString("utf8")); validateReport(report);
    need(canonical(report.binding) === canonical(envelope.binding)); return report;
  } catch { fail(); } finally { key?.fill(0); }
}
