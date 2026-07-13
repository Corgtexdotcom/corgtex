import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/routing", () => ({
  defineRouting: vi.fn((config) => config),
}));

import { demoUrlForLocale, enterpriseLoginUrlForLocale, signupUrlForLocale } from "./site";

const originalEnv = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_DEMO_URL: process.env.NEXT_PUBLIC_DEMO_URL,
  NEXT_PUBLIC_ENTERPRISE_APP_URL: process.env.NEXT_PUBLIC_ENTERPRISE_APP_URL,
};

afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = originalEnv.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_DEMO_URL = originalEnv.NEXT_PUBLIC_DEMO_URL;
  process.env.NEXT_PUBLIC_ENTERPRISE_APP_URL = originalEnv.NEXT_PUBLIC_ENTERPRISE_APP_URL;
});

describe("site URL helpers", () => {
  it("can route signup to the app URL while keeping demo on a separate URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://selfserve.corgtex.com";
    process.env.NEXT_PUBLIC_ENTERPRISE_APP_URL = "https://app.corgtex.com";
    process.env.NEXT_PUBLIC_DEMO_URL = "https://app.corgtex.com/demo";

    expect(signupUrlForLocale("en")).toBe("https://selfserve.corgtex.com/signup");
    expect(signupUrlForLocale("es")).toBe("https://selfserve.corgtex.com/es/signup");
    expect(enterpriseLoginUrlForLocale("en")).toBe("https://app.corgtex.com/find-account");
    expect(enterpriseLoginUrlForLocale("es")).toBe("https://app.corgtex.com/es/find-account");
    expect(demoUrlForLocale("en")).toBe("https://app.corgtex.com/demo");
    expect(demoUrlForLocale("es")).toBe("https://app.corgtex.com/es/demo");
  });

  it("falls back to the app URL when no separate demo URL is configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.corgtex.com";
    delete process.env.NEXT_PUBLIC_DEMO_URL;

    expect(demoUrlForLocale("en")).toBe("https://app.corgtex.com/demo");
    expect(demoUrlForLocale("es")).toBe("https://app.corgtex.com/es/demo");
  });
});
