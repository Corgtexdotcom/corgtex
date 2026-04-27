import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const integrationDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/corgtex_test?schema=public";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
      "@corgtex/domain": fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url)),
      "@corgtex/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@corgtex/agents": fileURLToPath(new URL("./packages/agents/src/index.ts", import.meta.url)),
      "@corgtex/models": fileURLToPath(new URL("./packages/models/src/index.ts", import.meta.url)),
      "@corgtex/knowledge": fileURLToPath(new URL("./packages/knowledge/src/index.ts", import.meta.url)),
      "@corgtex/workflows": fileURLToPath(new URL("./packages/workflows/src/index.ts", import.meta.url)),
      "@corgtex/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    isolate: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
          fileParallelism: false,
          globalSetup: ["./vitest.globalSetup.ts"],
          env: {
            DATABASE_URL: integrationDatabaseUrl,
          },
        },
      },
    ],
  },
});
