import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The new Preact app is served by the Worker at the /app path (the legacy
// dashboard keeps running at its own host). Build output goes to ../public/app
// because the Worker's static-assets root is ./public (see wrangler.toml). `base`
// must match the serve path so built asset URLs resolve correctly.
//
// Dev: `vite` serves the app and proxies /api to the local Worker (wrangler dev
// on :8787). Because local wrangler doesn't sit behind Cloudflare Access, we
// inject the owner's Access email header on proxied requests so authenticated
// writes work end-to-end in local development. This NEVER reaches production —
// the deployed edge sets/strips this header itself.
const DEV_ACCESS_EMAIL = process.env.DEV_ACCESS_EMAIL || "tony@homesolutionsar.com";

export default defineConfig({
  plugins: [preact()],
  base: "/app/",
  optimizeDeps: {
    include: ["tldraw", "@tldraw/editor", "@tldraw/store"],
  },
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
    rollupOptions: {
      // Two entries share the same assets/ dir and /app/ base:
      //   index.html → the authenticated app (served at /app)
      //   quote.html → the standalone public client quote page (served at
      //                 /quote/:token by the Worker; no app shell, no auth)
      input: {
        app: "index.html",
        quote: "quote.html",
        pay: "pay.html",
        portal: "portal.html",
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (!proxyReq.getHeader("Cf-Access-Authenticated-User-Email")) {
              proxyReq.setHeader("Cf-Access-Authenticated-User-Email", DEV_ACCESS_EMAIL);
            }
          });
        },
      },
    },
  },
});
