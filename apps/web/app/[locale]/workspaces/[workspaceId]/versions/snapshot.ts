export function snapshotText(snapshot: unknown) {
  if (snapshot && typeof snapshot === "object") {
    const record = snapshot as Record<string, unknown>;
    const body = record.bodyMd ?? record.descriptionMd ?? record.description ?? null;
    const keyResults = Array.isArray(record.keyResults) ? record.keyResults : null;
    if (typeof body === "string" && body.trim()) {
      if (keyResults) {
        return `${body}\n\nKey Results:\n${JSON.stringify(keyResults, null, 2)}`;
      }
      return body;
    }
    if (keyResults) {
      return JSON.stringify({ keyResults }, null, 2);
    }
  }
  return JSON.stringify(snapshot, null, 2);
}
