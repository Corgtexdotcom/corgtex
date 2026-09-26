import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/routing", () => ({
  defineRouting: vi.fn((config) => config),
}));

import { demoUrlForLocale, loginUrlForLocale, signupUrlForLocale } from "./site";

const originalEnv = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_DEMO_URL: process.env.NEXT_PUBLIC_DEMO_URL,
};

afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = originalEnv.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_DEMO_URL = originalEnv.NEXT_PUBLIC_DEMO_URL;
  vi.unstubAllEnvs();
});

describe("site URL helpers", () => {
  it("routes signup and login to selfserve while keeping demo on a separate URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://selfserve.corgtex.com";
    process.env.NEXT_PUBLIC_DEMO_URL = "https://app.corgtex.com/demo";

    expect(signupUrlForLocale("en")).toBe("https://selfserve.corgtex.com/signup");
    expect(signupUrlForLocale("es")).toBe("https://selfserve.corgtex.com/es/signup");
    expect(loginUrlForLocale("en")).toBe("https://selfserve.corgtex.com/login");
    expect(loginUrlForLocale("es")).toBe("https://selfserve.corgtex.com/es/login");
    expect(demoUrlForLocale("en")).toBe("https://app.corgtex.com/demo");
    expect(demoUrlForLocale("es")).toBe("https://app.corgtex.com/es/demo");
  });

  it("falls back to the app URL when no separate demo URL is configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.corgtex.com";
    delete process.env.NEXT_PUBLIC_DEMO_URL;

    expect(demoUrlForLocale("en")).toBe("https://app.corgtex.com/demo");
    expect(demoUrlForLocale("es")).toBe("https://app.corgtex.com/es/demo");
  });

  it("defaults production login to selfserve and demo to the backup app", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_DEMO_URL;

    expect(loginUrlForLocale("en")).toBe("https://selfserve.corgtex.com/login");
    expect(signupUrlForLocale("en")).toBe("https://selfserve.corgtex.com/signup");
    expect(demoUrlForLocale("en")).toBe("https://app.corgtex.com/demo");
  });
});
