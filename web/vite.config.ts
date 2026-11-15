import { resolve } from "node:path";
import { defineConfig } from "vite";

// A multi-page site: a landing page and one page per app. Each app lives in
// <app>/index.html with its code in src/<app>/; shared code is in src/common/.
export default defineConfig({
  // Relative asset paths so the build works at any URL prefix
  // (e.g. GitHub Pages serves this repo under /spacetime/).
  base: "./",
  build: {
    target: "es2022",
    // three.js makes the BBH bundle ~550 KB (~150 KB gzipped), which is expected.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        bbh: resolve(import.meta.dirname, "bbh/index.html"),
        lensing: resolve(import.meta.dirname, "lensing/index.html"),
        curvature: resolve(import.meta.dirname, "curvature/index.html"),
      },
    },
  },
});
