import { describe, expect, it } from "vitest";
import { renderAccountSetupEmail, renderPasswordResetEmail, renderPasswordResetEmailText } from "./email-templates";

describe("email templates", () => {
  it("renders account setup emails with onboarding context", () => {
    const html = renderAccountSetupEmail({
      setupUrl: "https://app.example/setup-account/token-1",
      displayName: "Ada",
      workspaceName: "Acme Ops",
      kind: "trial-claim",
    });

    expect(html).toContain("Your Corgtex workspace is ready");
    expect(html).toContain("Acme Ops is ready");
    expect(html).toContain("workspace newspaper");
    expect(html).toContain("recent context, decisions, meetings, tensions, and actions");
    expect(html).toContain("https://app.example/setup-account/token-1");
  });

  it("escapes user-provided account setup fields", () => {
    const html = renderAccountSetupEmail({
      setupUrl: "https://app.example/setup-account/token?next=<bad>",
      displayName: "<script>alert('x')</script>",
      workspaceName: "Acme <Ops>",
      kind: "member-invite",
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).toContain("Acme &lt;Ops&gt;");
    expect(html).toContain("next=&lt;bad&gt;");
    expect(html).not.toContain("<script>");
  });

  it("keeps password reset emails focused on account access", () => {
    const html = renderPasswordResetEmail({
      resetUrl: "https://app.example/reset-password/token-1",
      displayName: "Ada",
      kind: "existing-account",
    });

    expect(html).toContain("Reset your password");
    expect(html).toContain("already have a Corgtex account");
    expect(html).toContain("This link expires in 15 minutes");
    expect(html).not.toContain("What happens next");
  });

  it("renders a plain-text password reset alternative", () => {
    const text = renderPasswordResetEmailText({
      resetUrl: "https://app.example/reset-password/token-1",
      displayName: "Ada",
      kind: "self-service",
    });

    expect(text).toContain("Hi Ada,");
    expect(text).toContain("We received a request to reset your Corgtex password.");
    expect(text).toContain("https://app.example/reset-password/token-1");
    expect(text).toContain("This link expires in 15 minutes.");
    expect(text).not.toContain("<a");
  });
});
