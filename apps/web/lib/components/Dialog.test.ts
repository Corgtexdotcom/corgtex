import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("Dialog", () => {
  it("associates the modal with its visible title", () => {
    const html = renderToStaticMarkup(createElement(
      Dialog,
      { open: true, onClose: () => {}, title: "Resolve action" },
      "Resolution form",
    ));

    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("<h2 id=");
    expect(html).toContain("aria-label=\"close\"");
    expect(html).toContain("Resolve action");
  });
});
