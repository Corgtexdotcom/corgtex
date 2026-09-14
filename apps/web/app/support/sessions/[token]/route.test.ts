import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

describe("retired support links", () => {
  it("never offers confirmation or issues a session cookie", async () => {
    for (const handler of [GET, POST]) {
      const response = await handler();
      expect(response.status).toBe(410);
      expect(response.headers.has("set-cookie")).toBe(false);
      const html = await response.text();
      expect(html).toContain("workspace owner");
      expect(html).not.toContain("<form");
    }
  });
});
