export type DeliberationMentionTargetKind = "circle" | "member";

export type DeliberationMentionTarget = {
  value: string;
  label: string;
  kind: DeliberationMentionTargetKind;
  name: string;
};

export type ActiveMentionRange = {
  start: number;
  end: number;
  query: string;
};

const MENTION_BOUNDARY = /[\s([{,:;]/;
const MENTION_QUERY_BREAK = /[\s]/;
const TARGET_KIND_ORDER: Record<DeliberationMentionTargetKind, number> = {
  circle: 0,
  member: 1,
};

export function getActiveMentionRange(value: string, cursorIndex: number): ActiveMentionRange | null {
  const boundedCursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
  const beforeCursor = value.slice(0, boundedCursorIndex);
  const atIndex = beforeCursor.lastIndexOf("@");

  if (atIndex < 0) return null;

  const charBeforeMention = atIndex > 0 ? value[atIndex - 1] : "";
  if (charBeforeMention && !MENTION_BOUNDARY.test(charBeforeMention)) return null;

  const query = beforeCursor.slice(atIndex + 1);
  if (MENTION_QUERY_BREAK.test(query)) return null;

  return {
    start: atIndex,
    end: boundedCursorIndex,
    query,
  };
}

export function filterMentionTargets(
  targets: DeliberationMentionTarget[],
  query: string,
): DeliberationMentionTarget[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => (
      normalizedQuery.length === 0 || target.name.toLocaleLowerCase().includes(normalizedQuery)
    ))
    .sort((a, b) => {
      const kindDiff = TARGET_KIND_ORDER[a.target.kind] - TARGET_KIND_ORDER[b.target.kind];
      return kindDiff || a.index - b.index;
    })
    .map(({ target }) => target);
}

export function applyMentionSelection(
  value: string,
  mention: ActiveMentionRange,
  target: DeliberationMentionTarget,
): { value: string; cursorIndex: number } {
  const suffix = value.slice(mention.end);
  const insertion = `@${target.name}${suffix.startsWith(" ") ? "" : " "}`;
  const nextValue = `${value.slice(0, mention.start)}${insertion}${suffix}`;

  return {
    value: nextValue,
    cursorIndex: mention.start + insertion.length,
  };
}
