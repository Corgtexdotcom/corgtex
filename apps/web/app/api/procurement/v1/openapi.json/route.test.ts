import { describe, expect, it } from "vitest";

describe("GET /api/procurement/v1/openapi.json", () => {
  it("documents the trial setup endpoints", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.test/api/procurement/v1/openapi.json") as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paths).toHaveProperty("/product");
    expect(body.paths).toHaveProperty("/trials");
    expect(body.paths).toHaveProperty("/trials/{trialId}");
    expect(body.paths["/trials"].post.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Idempotency-Key", required: true })]),
    );
  });
});
