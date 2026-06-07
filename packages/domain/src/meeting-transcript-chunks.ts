export type MeetingTranscriptChunk = {
  chunkIndex: number;
  chunkCount: number;
  startChar: number;
  endChar: number;
  text: string;
};

export type BuildMeetingTranscriptChunksOptions = {
  targetChars?: number;
  overlapChars?: number;
};

export const MEETING_TRANSCRIPT_CHUNK_TARGET_CHARS = 16_000;
export const MEETING_TRANSCRIPT_CHUNK_OVERLAP_CHARS = 750;

function lastTurnBoundaryInWindow(transcript: string, start: number, end: number) {
  const window = transcript.slice(start, end);
  const matches = [...window.matchAll(/\n(?=[^\n]{1,80}:\s)/g)];
  const last = matches.at(-1);
  return last?.index === undefined ? -1 : start + last.index + 1;
}

function preferredChunkEnd(transcript: string, start: number, hardEnd: number, targetChars: number) {
  if (hardEnd >= transcript.length) return transcript.length;

  const minimumEnd = Math.min(hardEnd, start + Math.floor(targetChars * 0.65));
  const turnBoundary = lastTurnBoundaryInWindow(transcript, minimumEnd, hardEnd);
  if (turnBoundary > minimumEnd) return turnBoundary;

  const newline = transcript.lastIndexOf("\n", hardEnd);
  if (newline > minimumEnd) return newline + 1;

  return hardEnd;
}

export function buildMeetingTranscriptChunks(
  transcript: string,
  options: BuildMeetingTranscriptChunksOptions = {},
): MeetingTranscriptChunk[] {
  if (!transcript) return [];

  const targetChars = Math.max(1, options.targetChars ?? MEETING_TRANSCRIPT_CHUNK_TARGET_CHARS);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? MEETING_TRANSCRIPT_CHUNK_OVERLAP_CHARS, targetChars - 1));

  if (transcript.length <= targetChars) {
    return [{
      chunkIndex: 1,
      chunkCount: 1,
      startChar: 0,
      endChar: transcript.length,
      text: transcript,
    }];
  }

  const ranges: Array<{ startChar: number; endChar: number }> = [];
  let startChar = 0;

  while (startChar < transcript.length) {
    const hardEnd = Math.min(transcript.length, startChar + targetChars);
    const endChar = preferredChunkEnd(transcript, startChar, hardEnd, targetChars);
    const safeEndChar = endChar > startChar ? endChar : hardEnd;
    ranges.push({ startChar, endChar: safeEndChar });

    if (safeEndChar >= transcript.length) break;

    const nextStart = Math.max(0, safeEndChar - overlapChars);
    startChar = nextStart > startChar ? nextStart : safeEndChar;
  }

  return ranges.map((range, index) => ({
    chunkIndex: index + 1,
    chunkCount: ranges.length,
    startChar: range.startChar,
    endChar: range.endChar,
    text: transcript.slice(range.startChar, range.endChar),
  }));
}
