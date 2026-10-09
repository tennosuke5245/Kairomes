import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Kairomes Desktop currently ships on Windows and uses evergreen WebView2.
    // Avoid browser-wide legacy transforms that do not match the desktop runtime.
    target: "chrome105",
    // Loaded from disk by the WebView, never over a network; Phosphor icons carry every weight.
    chunkSizeWarningLimit: 640,
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
