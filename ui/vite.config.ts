import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: uiDir,
  plugins: [react()],
  build: {
    // La UI compilada queda en dist/ui, donde `mp ui` la sirve.
    outDir: path.resolve(uiDir, "..", "dist", "ui"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // La UI importa tipos y constantes de ../src/core (fuera de esta carpeta).
    fs: { allow: [path.resolve(uiDir, "..")] },
    // En desarrollo (npm run dev:ui) la API la sirve `mp ui`, que debe estar
    // corriendo en el puerto 4777. changeOrigin pone el Host que `mp ui`
    // exige (127.0.0.1:4777); sin eso respondería 403.
    proxy: {
      "/api": { target: "http://127.0.0.1:4777", changeOrigin: true },
    },
  },
});
