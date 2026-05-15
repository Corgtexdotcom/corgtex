const MEETING_BLOCK_METADATA_PREFIX = "**MEETING BLOCK:**";
const MEETING_BLOCK_KIND_PREFIX = "**BLOCK KIND:**";

export function parseMeetingBlockContext(bodyMd: string | null | undefined) {
  const body = bodyMd ?? "";
  const lines = body.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine.startsWith(MEETING_BLOCK_METADATA_PREFIX)) {
    return { blockTitle: null, blockKind: null, bodyMd: body };
  }

  const blockTitle = firstLine.slice(MEETING_BLOCK_METADATA_PREFIX.length).trim() || null;
  let blockKind: string | null = null;
  let bodyStartIndex = 1;
  const secondLine = lines[1]?.trim() ?? "";
  if (secondLine.startsWith(MEETING_BLOCK_KIND_PREFIX)) {
    blockKind = secondLine.slice(MEETING_BLOCK_KIND_PREFIX.length).trim() || null;
    bodyStartIndex = 2;
  }
  while (bodyStartIndex < lines.length && lines[bodyStartIndex]?.trim() === "") {
    bodyStartIndex += 1;
  }

  return {
    blockTitle,
    blockKind,
    bodyMd: lines.slice(bodyStartIndex).join("\n").trim(),
  };
}
