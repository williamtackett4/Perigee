import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the built asset paths relative, so the same build works
// whether it is served from a domain root (Netlify) or a repo subpath
// (https://<user>.github.io/perigee/). Do not change this to an absolute path.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
});
