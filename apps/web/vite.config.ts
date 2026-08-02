import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// El .env vive en la raíz del repo, junto al .env.example que documenta todo.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const env = loadEnv(process.env.NODE_ENV ?? "development", ROOT, "");
const INSTANCE = env.NODE_SERVER_URL || "http://localhost:5000";

/**
 * Cuando la instancia está apagada, el proxy responde 500 con cuerpo vacío y en
 * el navegador eso se lee como "Internal Server Error", que manda a depurar el
 * sitio equivocado. Aquí se dice en el terminal qué pasa de verdad.
 */
const onProxyError: ProxyOptions["configure"] = (proxy) => {
  proxy.on("error", (err, _req, res) => {
    console.error(`\n  ⚠  La instancia no responde en ${INSTANCE} (${err.message}).`);
    console.error("     Arráncala con:  npm run dev:server\n");
    if ("writeHead" in res && !res.headersSent) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: {
            code: "INSTANCE_UNREACHABLE",
            message: `La instancia no responde en ${INSTANCE}. ¿Está arrancada?`,
            status: 503,
            requestId: "vite-proxy",
            timestamp: new Date().toISOString(),
          },
        }),
      );
    }
  });
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@distop/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Proxy en desarrollo: el cliente habla siempre con su propio origen, así que
    // no hay CORS que configurar ni token viajando entre dominios distintos.
    proxy: {
      "/api": { target: INSTANCE, changeOrigin: true, configure: onProxyError },
      "/health": { target: INSTANCE, changeOrigin: true, configure: onProxyError },
      "/realtime": { target: INSTANCE, ws: true, configure: onProxyError },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
