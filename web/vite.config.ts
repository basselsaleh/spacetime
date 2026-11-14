import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works at any URL prefix
  // (e.g. GitHub Pages serves this repo under /spacetime/).
  base: "./",
  build: { target: "es2022" },
});
