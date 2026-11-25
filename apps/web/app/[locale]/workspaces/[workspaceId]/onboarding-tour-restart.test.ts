import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingRestartButton } from "./settings/OnboardingRestartButton";
import { listenForTourRestart } from "./onboarding-tour-restart";

import { WorkspaceOnboardingTour } from "./WorkspaceOnboardingTour";

const route = vi.hoisted(() => ({ router: { push: vi.fn() }, drive: vi.fn(), translate: (key: string) => key }));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => route.router,
}));
vi.mock("next-intl", () => ({ useTranslations: () => route.translate }));
vi.mock("driver.js", () => ({ driver: () => ({ drive: route.drive, destroy: vi.fn() }) }));
vi.mock("@/lib/components/Dialog", () => ({ Dialog: () => null }));
vi.mock("./OnboardingAiWorkspaceSetup", () => ({ OnboardingAiWorkspaceSetup: () => null }));
vi.mock("./SourceIntakePanel", () => ({ SourceIntakePanel: () => null }));

const buttons = new Map<string, { dataset: Record<string, string> }>();

function renderButton(workspaceId: string) {
  const { props } = OnboardingRestartButton({ workspaceId });
  const button = { dataset: {} };
  buttons.set(props.id, button);
  return { click: () => props.onClick({ currentTarget: button }), remove: () => buttons.delete(props.id) };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { getElementById: (id: string) => buttons.get(id) ?? null });
});
afterEach(() => {
  buttons.clear();
  vi.unstubAllGlobals();
});

it("replays an early Settings click once when its own workspace tour finishes loading", () => {
  const button = renderButton("first");
  const other = vi.fn();
  const stopOther = listenForTourRestart("second", other);
  button.click();
  expect(other).not.toHaveBeenCalled();

  const restart = vi.fn();
  const listener = listenForTourRestart("first", restart);
  expect(listener.replayed).toBe(true);
  expect(restart).toHaveBeenCalledTimes(1);
  listener.unsubscribe();
  const remounted = listenForTourRestart("first", restart);
  expect(remounted.replayed).toBe(false);
  expect(restart).toHaveBeenCalledTimes(1);
  button.click();
  expect(restart).toHaveBeenCalledTimes(2);
  expect(other).not.toHaveBeenCalled();
  remounted.unsubscribe();
  stopOther.unsubscribe();
});

it("drops a pending restart if the user leaves Settings before the proof completes", () => {
  const button = renderButton("first");
  button.click();
  button.remove();
  renderButton("first");
  const restart = vi.fn();
  const listener = listenForTourRestart("first", restart);
  expect(listener.replayed).toBe(false);
  expect(restart).not.toHaveBeenCalled();
  listener.unsubscribe();
});

it("keeps the existing untargeted restart event working for a mounted tour", () => {
  const restart = vi.fn();
  const listener = listenForTourRestart("first", restart);
  window.dispatchEvent(new CustomEvent("corgtex:restart-self-serve-tour"));
  expect(restart).toHaveBeenCalledTimes(1);
  listener.unsubscribe();
});


it("runs the completed tour on Home only after a delayed Settings-to-Home commit", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The dialog is closed and renders no host nodes. React handles the real effect lifecycle.
  const location = new URL("https://fixture.invalid/en/workspaces/first/settings?tab=general");
  const ownerDocument = Object.assign(new EventTarget(), { getElementById: document.getElementById });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument,
  });
  Object.assign(window, { location, document: ownerDocument, HTMLIFrameElement: class {} });
  vi.stubGlobal("document", ownerDocument);
  const root = createRoot(container as unknown as Element);
  const props = {
    workspaceId: "first", tourKey: "tour", tourVersion: "1", initialCompletedAt: "2026-01-01",
    hasInitialKnowledge: true, aiWorkspaceState: { activeProviderKey: null, providers: [], connections: [] },
    connectorUrl: "/mcp", origin: location.origin,
  };
  try {
    renderButton("first").click();
    await act(async () => root.render(React.createElement(WorkspaceOnboardingTour, props)));
    expect(route.router.push).toHaveBeenCalledExactlyOnceWith("/workspaces/first");
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(route.drive).not.toHaveBeenCalled();

    location.pathname = "/en/workspaces/first";
    location.search = "";
    await act(async () => root.render(React.createElement(WorkspaceOnboardingTour, props)));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(route.drive).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
