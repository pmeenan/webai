import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  site: "https://webai.meenan.dev",
  base: "/",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
  },
});
