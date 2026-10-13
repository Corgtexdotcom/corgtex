import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { marked } from "marked";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MarkdownEditor Write rendering", () => {
  it.each([1, 40, 200])("does not parse a %i KiB uncontrolled draft", (kib) => {
    const parse = vi.spyOn(marked, "parse");
    const draft = "x".repeat(kib * 1024);
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { name: "bodyMd", defaultValue: draft }));

    expect(parse).not.toHaveBeenCalled();
    expect(html).not.toContain("md-editor-preview");
    expect(html).toContain(draft);
  });

  it.each([1, 40, 200])("does not parse a %i KiB controlled draft", (kib) => {
    const parse = vi.spyOn(marked, "parse");
    const draft = "x".repeat(kib * 1024);
    const html = renderToStaticMarkup(createElement(MarkdownEditor, {
      name: "bodyMd", value: draft, defaultValue: "Unused default", onValueChange: vi.fn(),
    }));

    expect(parse).not.toHaveBeenCalled();
    expect(html).toContain(draft);
    expect(html).not.toContain("Unused default");
  });

  it("preserves textarea validation, identity, labels and mention attributes", () => {
    const html = renderToStaticMarkup(createElement(MarkdownEditor, {
      id: "draft", name: "bodyMd", value: "", defaultValue: "Unused default",
      ariaLabel: "Draft body", ariaAutocomplete: "list", ariaControls: "mentions",
      ariaActivedescendant: "mention-1", required: true, disabled: true, rows: 8,
      placeholder: "Write a draft",
    }));

    expect(html).toContain('id="draft"');
    expect(html).toContain('name="bodyMd"');
    expect(html).toContain('aria-label="Draft body"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-controls="mentions"');
    expect(html).toContain('aria-activedescendant="mention-1"');
    expect(html).toContain('rows="8"');
    expect(html).toContain('placeholder="Write a draft"');
    expect(html).toContain(" required");
    expect(html).toContain(" disabled");
    expect(html).toContain('aria-label="bold"');
    expect(html).not.toContain("Unused default");
  });

  it("exposes all formatting actions as disabled when editing is disabled", () => {
    const html = renderToStaticMarkup(createElement(MarkdownEditor, { name: "bodyMd", defaultValue: "Synthetic draft", disabled: true }));
    const formattingButtons = [...html.matchAll(/<button\b[^>]*aria-label=[^>]*>/g)].map((match) => match[0]);
    expect(formattingButtons).toHaveLength(9);
    expect(formattingButtons.every((button) => button.includes(" disabled"))).toBe(true);
  });
});
