const restartEvent = "corgtex:restart-self-serve-tour";

export function tourRestartButtonId(workspaceId: string) {
  return `workspace-tour-restart-${workspaceId}`;
}

export function requestTourRestart(button: HTMLButtonElement, workspaceId: string) {
  // The request expires with the Settings button when the user leaves the page.
  button.dataset.tourRestartPending = "true";
  window.dispatchEvent(new CustomEvent(restartEvent, { detail: workspaceId }));
}

export function listenForTourRestart(workspaceId: string, restart: () => void) {
  function consumeButtonRequest() {
    const button = document.getElementById(tourRestartButtonId(workspaceId));
    if (button?.dataset.tourRestartPending !== "true") return false;
    delete button.dataset.tourRestartPending;
    return true;
  }

  function handleRequest(event: Event) {
    const target = (event as CustomEvent<string>).detail;
    if (target && target !== workspaceId) return;
    consumeButtonRequest();
    restart();
  }

  window.addEventListener(restartEvent, handleRequest);
  const replayed = consumeButtonRequest();
  if (replayed) restart();
  return { replayed, unsubscribe: () => window.removeEventListener(restartEvent, handleRequest) };
}
