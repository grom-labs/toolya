import { defineConfig } from "vite";

// Two pages: the landing (index.html) and the tool (app.html).
// Dev server: `npm run dev` inside toolya-build (port 5173, host 0.0.0.0).
// HTTPS via Traefik reverse proxy at https://local.toolya.dev (real LE cert).
export default defineConfig({
  server: {
    host: true,
    hmr: {
      host: "local.toolya.dev",
      protocol: "wss",
    },
    proxy: {
      "/api": {
        target: "https://toolya.dev",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: { main: "index.html", app: "app.html" },
    },
  },
});
