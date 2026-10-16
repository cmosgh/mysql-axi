import { defineConfig } from "vitest/config";

// Local only: spends model tokens. Same throwaway MySQL container as the integration suite.
export default defineConfig({
  test: {
    include: ["test/tokens/**/*.test.ts"],
    globalSetup: ["test/integration/server.ts"],
    hookTimeout: 3 * 60 * 60_000,
    testTimeout: 60_000,
  },
});
