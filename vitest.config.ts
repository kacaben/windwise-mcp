import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The stdio entry point only wires the server to a transport; the smoke test covers it.
      exclude: ["src/index.ts"],
      reporter: ["text-summary", "text"],
    },
  },
});
