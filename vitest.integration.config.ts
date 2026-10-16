import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/server.ts"],
    // One shared server, and some tests change its globals (sql_mode).
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
