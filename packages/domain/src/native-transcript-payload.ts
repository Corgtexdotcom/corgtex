import { createHash } from "node:crypto";

export function nativeTranscriptCanonicalPayload(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(nativeTranscriptCanonicalPayload).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${nativeTranscriptCanonicalPayload(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export const nativeTranscriptPayloadHash = (payload: unknown) => createHash("sha256").update(nativeTranscriptCanonicalPayload(payload)).digest("hex");
