import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DuplicateGuardConfirmationPanel, type DuplicateGuardFormState } from "./DuplicateGuardForm";

describe("DuplicateGuardConfirmationPanel", () => {
  it("renders the duplicate candidate and all resolution buttons", () => {
    const state: DuplicateGuardFormState = {
      status: "duplicate_confirmation_required",
      candidate: {
        entityType: "Action",
        entityId: "action-existing",
        title: "Send Acme proposal",
        excerpt: "Send proposal notes",
        score: 0.91,
        matchKind: "likely",
        reasons: ["similar title", "same assignee"],
      },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    };

    const html = renderToStaticMarkup(createElement(DuplicateGuardConfirmationPanel, { state, isPending: false }));

    expect(html).toContain("Possible duplicate");
    expect(html).toContain("Send Acme proposal");
    expect(html).toContain("value=\"action-existing\"");
    expect(html).toContain("value=\"use_existing\"");
    expect(html).toContain("value=\"update_existing\"");
    expect(html).toContain("value=\"create_new\"");
  });

  it("preserves a create submit intent through duplicate confirmation", () => {
    const state: DuplicateGuardFormState = {
      status: "duplicate_confirmation_required",
      candidate: {
        entityType: "Action",
        entityId: "action-existing",
        title: "Send Acme proposal",
        excerpt: null,
        score: 0.91,
        matchKind: "likely",
        reasons: [],
      },
      recommendedResolution: "create_new",
      allowedResolutions: ["create_new"],
      submitIntent: "open",
    };

    const html = renderToStaticMarkup(createElement(DuplicateGuardConfirmationPanel, { state, isPending: false }));

    expect(html).toContain("name=\"submitIntent\"");
    expect(html).toContain("value=\"open\"");
  });
});
