import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionPrioritySelect, type ActionPriorityLabels } from "./ActionPrioritySelect";

const labels: ActionPriorityLabels = {
  label: "Priority",
  help: "Choose how this action should rank against other work.",
  none: "None",
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
  legacy: "Current custom priority P{priority}",
};

describe("ActionPrioritySelect", () => {
  it("renders the explained priority pulldown", () => {
    const html = renderToStaticMarkup(createElement(ActionPrioritySelect, {
      labels,
      defaultValue: 2,
    }));

    expect(html).toContain("name=\"priority\"");
    expect(html).toContain("Normal");
    expect(html).toContain("Urgent");
    expect(html).toContain(labels.help);
  });

  it("preserves legacy priority values until the user changes them", () => {
    const html = renderToStaticMarkup(createElement(ActionPrioritySelect, {
      labels,
      defaultValue: 9,
    }));

    expect(html).toContain("value=\"9\"");
    expect(html).toContain("Current custom priority P9");
  });
});
