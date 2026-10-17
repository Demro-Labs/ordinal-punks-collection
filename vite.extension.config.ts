import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(root, "client", "src"),
      "@shared": path.resolve(root, "shared"),
    },
  },
  envDir: root,
  root: path.resolve(root, "client"),
  publicDir: path.resolve(root, "client", "extension-public"),
  build: {
    outDir: path.resolve(root, "dist", "extension"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(root, "client", "extension.html"),
    },
  },
});
