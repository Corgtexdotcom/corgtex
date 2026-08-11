import { types as nodeTypes } from "node:util";

type Reader = Readonly<{
  exactRecord<const K extends readonly string[]>(value: unknown, keys: K): { readonly [P in K[number]]: unknown };
  literal<const T extends string | number | boolean | null>(value: unknown, expected: T): T;
  enumString<const T extends readonly string[]>(value: unknown, allowed: T): T[number];
  integer(value: unknown, min: number, max: number): number;
  uuid(value: unknown): string;
  machineId(value: unknown): string;
  version(value: unknown): string;
  gitSha(value: unknown): string;
  imageTag(value: unknown, gitSha: string): string;
  sha256Hex(value: unknown): string;
  digest(value: unknown): string;
  azureResourceGroup(value: unknown): string;
  azureAcrName(value: unknown): string;
  azureAcrServer(value: unknown, acrName: string): string;
  azureAppName(value: unknown): string;
  azureContainerName(value: unknown): string;
  azureImage(value: unknown, role: "web" | "worker"): Readonly<{
    image: string; acrName: string; acrServer: string; digest: string;
  }>;
  azureRevision(value: unknown, appName: string): string;
  deepFreeze<T>(value: T): T;
  canonicalJsonBytes(value: unknown): Uint8Array;
}>;

export function createManagedReleaseProofReader(invalid: () => never): Reader {
  const rawSeen = new WeakSet<object>(); const snapshots = new WeakSet<object>(); const validated = new WeakSet<object>();
  function fail(): never { return invalid(); }
  const safeText = (value: string) => {
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };
  const safeAsciiScalar = (value: string) => safeText(value) && value === value.trim() && /^[\x20-\x7e]*$/.test(value);
  const objectValue = (value: unknown): object => {
    if (nodeTypes.isProxy(value)) fail();
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
    return value;
  };
  const inspectRecord = (value: object): { value: object; descriptors: Record<PropertyKey, PropertyDescriptor>; keys: string[] } => {
    let prototype: object | null; let keys: PropertyKey[]; let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>; } catch { fail(); }
    if (keys.length > 1_024) fail();
    if (prototype !== Object.prototype && prototype !== null) fail();
    if (keys.some((key) => typeof key !== "string" || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) fail();
    return { value, descriptors, keys: keys as string[] };
  };
  const describeRecord = (value: unknown) => inspectRecord(objectValue(value));
  const primitive = (value: unknown) => value === null || typeof value === "boolean"
    || (typeof value === "string" && safeText(value))
    || (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0));
  const pattern = (value: unknown, min: number, max: number, expression: RegExp): string => {
    if (typeof value !== "string") fail();
    if (value.length < min || value.length > max || !expression.test(value)) fail();
    return value;
  };
  const parseGitSha = (value: unknown) => pattern(value, 40, 40, /^[0-9a-f]{40}$/);
  const parseAcrName = (value: unknown) => pattern(value, 5, 50, /^[a-z0-9]+$/);
  const parseAppName = (value: unknown) => {
    const name = pattern(value, 2, 31, /^[a-z][a-z0-9-]*[a-z0-9]$/);
    if (name.includes("--")) fail();
    return name;
  };
  const parseContainerName = (value: unknown, max = 63) => pattern(value, 1, max, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  const exactRecord: Reader["exactRecord"] = (value, keys) => {
    const record = describeRecord(value);
    if (new Set(keys).size !== keys.length || record.keys.length !== keys.length || keys.some((key) => !Object.hasOwn(record.descriptors, key))) fail();
    if (rawSeen.has(record.value)) fail();
    rawSeen.add(record.value);
    const snapshot = Object.freeze(Object.fromEntries(keys.map((key) => [key, record.descriptors[key]!.value])));
    snapshots.add(snapshot); return snapshot as never;
  };
  const literal: Reader["literal"] = (value, expected) => {
    if (!primitive(value) || !Object.is(value, expected) || (typeof value === "string" && !safeAsciiScalar(value))) fail();
    return expected;
  };
  const enumString: Reader["enumString"] = (value, allowed) => {
    if (typeof value !== "string") fail();
    if (!allowed.includes(value) || !safeAsciiScalar(value)) fail();
    return value as never;
  };
  const integer = (value: unknown, min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) fail();
    if (typeof value !== "number") fail();
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail();
    return value;
  };
  const deepFreeze = <T>(value: T): T => {
    const objects: object[] = []; const seen = new Set<object>(); const pending: unknown[] = [value];
    while (pending.length) {
      const item = pending.pop(); if (primitive(item)) continue;
      const object = objectValue(item); if (!snapshots.has(object) || seen.has(object) || objects.length >= 1_024) fail();
      const record = inspectRecord(object); if (!Object.isFrozen(record.value)) fail();
      seen.add(record.value); objects.push(record.value);
      for (const key of record.keys) pending.push(record.descriptors[key]!.value);
    }
    for (let index = objects.length - 1; index >= 0; index -= 1) Object.freeze(objects[index]!);
    for (const object of objects) validated.add(object);
    return value;
  };
  const canonicalJsonBytes = (value: unknown) => {
    const tokens: string[] = [];
    let chars = 0;
    const emit = (token: string) => {
      chars += token.length;
      if (chars > 16_384) fail();
      tokens.push(token);
    };
    const seen = new Set<object>();
    let visited = 0;
    const encode = (item: unknown, depth: number): void => {
      visited += 1;
      if (visited > 1_024 || depth > 32) fail();
      if (item === null) return emit("null");
      if (typeof item === "boolean") return emit(item ? "true" : "false");
      if (typeof item === "number") {
        if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail();
        return emit(String(item));
      }
      if (typeof item === "string") {
        if (item.length > 16_384 || !safeText(item)) fail();
        return emit(JSON.stringify(item));
      }
      const object = objectValue(item); if (!validated.has(object)) fail(); const record = inspectRecord(object);
      if (seen.has(record.value)) fail();
      seen.add(record.value);
      emit("{");
      const keys = [...record.keys].sort();
      keys.forEach((key, index) => {
        if (key.length > 16_384 || !safeText(key)) fail();
        if (index) emit(",");
        emit(JSON.stringify(key)); emit(":"); encode(record.descriptors[key]!.value, depth + 1);
      });
      emit("}");
    };
    encode(value, 0);
    const bytes = new TextEncoder().encode(tokens.join(""));
    if (bytes.byteLength > 16_384) fail();
    return bytes;
  };
  const reader: Reader = {
    exactRecord,
    literal,
    enumString,
    integer,
    uuid: (value) => pattern(value, 36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    machineId: (value) => pattern(value, 1, 128, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    version: (value) => pattern(value, 1, 128, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    gitSha: parseGitSha,
    imageTag: (value, gitSha) => literal(value, `sha-${parseGitSha(gitSha)}`),
    sha256Hex: (value) => pattern(value, 64, 64, /^[0-9a-f]{64}$/),
    digest: (value) => pattern(value, 71, 71, /^sha256:[0-9a-f]{64}$/),
    azureResourceGroup: (value) => {
      const group = pattern(value, 1, 90, /^[A-Za-z0-9][A-Za-z0-9_.()-]*$/);
      if (group.endsWith(".")) fail();
      return group;
    },
    azureAcrName: parseAcrName,
    azureAcrServer: (value, acrName) => literal(value, `${parseAcrName(acrName)}.azurecr.io`),
    azureAppName: parseAppName,
    azureContainerName: (value) => parseContainerName(value),
    azureImage: (value, role) => {
      if (typeof value !== "string") fail();
      if (role !== "web" && role !== "worker") fail();
      const match = /^([a-z0-9]{5,50})\.azurecr\.io\/corgtex\/(web|worker)@(sha256:[0-9a-f]{64})$/.exec(value);
      if (!match) fail();
      if (match[2] !== role) fail();
      return deepFreeze(exactRecord({ image: value, acrName: parseAcrName(match[1]), acrServer: `${match[1]}.azurecr.io`, digest: match[3]! }, ["image", "acrName", "acrServer", "digest"] as const)) as never;
    },
    azureRevision: (value, appName) => {
      const prefix = `${parseAppName(appName)}--`;
      if (typeof value !== "string") fail();
      if (value.length <= prefix.length || value.length > prefix.length + 64 || !value.startsWith(prefix)) fail();
      const suffix = parseContainerName(value.slice(prefix.length), 64);
      if (suffix.includes("--")) fail();
      return value;
    },
    deepFreeze,
    canonicalJsonBytes,
  };
  if (nodeTypes.isProxy(reader)) fail();
  return Object.freeze(reader);
}
