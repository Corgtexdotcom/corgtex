import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MultiSelectFilter } from "./MultiSelectFilter";

const options = [
  { value: "member-1", label: "Ada Lovelace" },
  { value: "member-2", label: "Grace Hopper" },
];

describe("MultiSelectFilter", () => {
  it("serializes selected values through hidden inputs when the panel is closed", () => {
    const html = renderToStaticMarkup(createElement(MultiSelectFilter, {
      name: "memberIds",
      options,
      selectedValues: ["member-1"],
      allLabel: "Choose people",
      collapseAllToEmpty: false,
    }));

    expect(html).toContain("type=\"hidden\"");
    expect(html).toContain("name=\"memberIds\"");
    expect(html).toContain("value=\"member-1\"");
    expect(html).not.toContain("value=\"member-2\"");
  });

  it("keeps filter semantics by collapsing all selected values to empty by default", () => {
    const html = renderToStaticMarkup(createElement(MultiSelectFilter, {
      name: "memberId",
      options,
      selectedValues: ["member-1", "member-2"],
      allLabel: "All people",
    }));

    expect(html).not.toContain("type=\"hidden\"");
    expect(html).toContain("All people");
  });

  it("can preserve all selected values for recipient pickers", () => {
    const html = renderToStaticMarkup(createElement(MultiSelectFilter, {
      name: "memberIds",
      options,
      selectedValues: ["member-1", "member-2"],
      allLabel: "Choose people",
      collapseAllToEmpty: false,
    }));

    expect(html).toContain("value=\"member-1\"");
    expect(html).toContain("value=\"member-2\"");
  });
});
