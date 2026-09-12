import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";

describe("confirmation before form submission", () => {
  it("prevents submission of server-rendered forms before the confirmation handler hydrates", () => {
    const props = {
      confirmMessage: "Archive this record?",
      children: "Archive",
    };
    const html = renderToStaticMarkup(createElement(ConfirmSubmitButton, props));
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
  });
});
