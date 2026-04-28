import { describe, expect, it } from "vitest";

describe("GET /api/procurement/v1/openapi.json", () => {
  it("documents the procurement setup endpoints", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://app.test/api/procurement/v1/openapi.json") as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paths).toHaveProperty("/product");
    expect(body.paths).toHaveProperty("/workspaces");
    expect(body.paths).toHaveProperty("/setup-sessions/{id}");
    expect(body.paths).toHaveProperty("/setup-sessions/{id}/members/bulk-invite");
    expect(body.paths["/workspaces"].post.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Idempotency-Key", required: true })]),
    );
  });
});
