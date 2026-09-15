import { expect, it } from "vitest";
import { validationEmails } from "./qa-identities.mjs";

it("rejects the same administrator/member despite whitespace or case", () => {
  expect(() => validationEmails({ VALIDATION_BOOTSTRAP_ADMIN_EMAIL: " QA@validation.example ", QA_VALIDATION_MEMBER_EMAIL: "qa@validation.example" })).toThrow("separate identities");
});

it("normalizes distinct identities consistently for provisioning", () => {
  expect(validationEmails({ VALIDATION_BOOTSTRAP_ADMIN_EMAIL: " ADMIN@validation.example ", QA_VALIDATION_MEMBER_EMAIL: " Member@validation.example " })).toEqual({ adminEmail: "admin@validation.example", memberEmail: "member@validation.example" });
});
