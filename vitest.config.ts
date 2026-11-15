import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Sin colores, para comparar la salida como texto plano.
    env: { NO_COLOR: "1" },
    // Las pruebas usan repos git reales; en Windows cada llamada a git es lenta.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
