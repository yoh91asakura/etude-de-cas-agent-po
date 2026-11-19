import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/** Adresse de l'API (Fastify). Surchargeable : API_URL=http://127.0.0.1:3000 npm run dev -w @po-agent/web */
const API = process.env.API_URL ?? "http://localhost:3000";

/**
 * Proxy de /api vers l'API, y compris le flux SSE /api/flux.
 * Pour le flux : pas de compression, pas de délai d'inactivité, en-têtes anti-tampon.
 */
const proxyApi: Record<string, ProxyOptions> = {
  "/api": {
    target: API,
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        if (req.url?.startsWith("/api/flux")) {
          proxyReq.setHeader("Accept-Encoding", "identity");
          proxyReq.setHeader("Cache-Control", "no-cache");
        }
      });
      proxy.on("proxyRes", (proxyRes, _req, res) => {
        if (String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream")) {
          proxyRes.headers["cache-control"] = "no-cache, no-transform";
          proxyRes.headers["x-accel-buffering"] = "no";
          delete proxyRes.headers["content-length"];
          res.setTimeout(0);
        }
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: proxyApi },
  preview: { port: 4173, proxy: proxyApi },
});
