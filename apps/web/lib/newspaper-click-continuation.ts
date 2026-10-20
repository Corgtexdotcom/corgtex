/** Login may resume only this authenticated read endpoint, never an arbitrary URL. */
export function newspaperClickContinuation(value: unknown): string | null {
  return typeof value === "string" && /^\/api\/newspaper\/click\/[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}
