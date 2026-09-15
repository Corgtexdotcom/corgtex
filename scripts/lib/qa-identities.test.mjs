import { expect, it } from "vitest";
import { validationEmails, validateQaPasswords } from "./qa-identities.mjs";

it("rejects the same administrator/member despite whitespace or case", () => {
  expect(() => validationEmails({ VALIDATION_BOOTSTRAP_ADMIN_EMAIL: " QA@validation.example ", QA_VALIDATION_MEMBER_EMAIL: "qa@validation.example" })).toThrow("separate identities");
});

it("normalizes distinct identities consistently for provisioning", () => {
  expect(validationEmails({ VALIDATION_BOOTSTRAP_ADMIN_EMAIL: " ADMIN@validation.example ", QA_VALIDATION_MEMBER_EMAIL: " Member@validation.example " })).toEqual({ adminEmail: "admin@validation.example", memberEmail: "member@validation.example" });
});

it.each(["ADMIN_PASSWORD", "QA_VALIDATION_MEMBER_PASSWORD"])("rejects short login credentials before seed writes: %s", (name) => {
  expect(() => validateQaPasswords({ ADMIN_PASSWORD: "valid-password", QA_VALIDATION_MEMBER_PASSWORD: "valid-password", [name]: "short" })).toThrow("at least 8");
});
