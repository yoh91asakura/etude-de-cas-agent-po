import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // Plusieurs Postgres embarqués (PGlite) démarrent en parallèle : on laisse de la marge.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
