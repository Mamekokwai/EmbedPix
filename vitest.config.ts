import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Windows cold-start CI can spend several seconds loading the pure logic suite.
    testTimeout: 15_000,
  },
});
