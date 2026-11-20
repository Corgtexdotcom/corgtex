// Driver.js supplies no element for centered steps, then adds trigger ARIA to
// its decorative dummy div after this hook. Clear the invalid expanded state
// before the next paint; the popover retains its own dialog semantics.
export function onTourHighlightStarted(element: Element | undefined) {
  if (element) return;
  queueMicrotask(() => {
    document.getElementById("driver-dummy-element")?.removeAttribute("aria-expanded");
  });
}
