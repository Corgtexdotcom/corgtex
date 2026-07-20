import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastMessage } from "./Toast";

describe("ToastMessage", () => {
  it("renders success toasts as announced status messages with a dismiss button", () => {
    const html = renderToStaticMarkup(createElement(ToastMessage, {
      toast: { id: "toast-1", message: "Saved", type: "success" },
      onDismiss: () => {},
    }));

    expect(html).toContain("role=\"status\"");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("Dismiss notification");
    expect(html).toContain("Saved");
  });

  it("renders error toasts as assertive alerts", () => {
    const html = renderToStaticMarkup(createElement(ToastMessage, {
      toast: { id: "toast-2", message: "Could not save", type: "error" },
      onDismiss: () => {},
    }));

    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("aria-live=\"assertive\"");
  });
});
