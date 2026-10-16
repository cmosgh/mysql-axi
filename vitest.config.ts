import { configDefaults, defineConfig } from "vitest/config";

// test:integration needs Docker; test:tokens also spends model tokens. Neither runs here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/integration/**", "test/tokens/**"] },
});
