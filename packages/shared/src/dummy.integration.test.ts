import { describe, expect, it } from "vitest";
import { getPrismaClient } from "./db";

describe("dummy integration test", () => {
  it("connects to the test database and can query it", async () => {
    const prisma = getPrismaClient();
    const result = await prisma.$queryRaw`SELECT 1 as val;`;
    expect(result).toEqual([{ val: 1 }]);
  });
});
