import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainArticleTypeControl } from "./BrainArticleTypeControl";

describe("Brain article type control", () => {
  it("shows a DIGEST's stored type without submitting a replacement type", () => {
    const html = renderToStaticMarkup(React.createElement(BrainArticleTypeControl, { type: "DIGEST", label: "Type" }));

    expect(html).toContain('aria-label="Type"');
    expect(html).toContain('value="DIGEST"');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain('name="type"');
    expect(html).not.toContain("PRODUCT");
  });

  it("keeps ordinary article types editable and selected", () => {
    const html = renderToStaticMarkup(React.createElement(BrainArticleTypeControl, { type: "PROJECT", label: "Type" }));

    expect(html).toContain('<select name="type"');
    expect(html).toMatch(/<option value="PROJECT" selected="">PROJECT<\/option>/);
    expect(html).not.toContain('value="DIGEST"');
  });
});
