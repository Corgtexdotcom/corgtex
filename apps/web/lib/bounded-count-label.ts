/** A lower bound is never formatted as an exact total, including a hidden-only window. */
export function boundedCountLabel(window: {count: number | null; complete: boolean; available?: boolean}) {
  if (window.available === false || window.count === null) return "…";
  if (window.complete) return String(window.count);
  return window.count > 0 ? `${window.count}+` : "…";
}
