import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const certificatePath = resolve(projectRoot, ".cert", "tba-local.crt");
const certificateKeyPath = resolve(projectRoot, ".cert", "tba-local.key");
const localHttps = existsSync(certificatePath) && existsSync(certificateKeyPath)
  ? { cert: readFileSync(certificatePath), key: readFileSync(certificateKeyPath) }
  : undefined;

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function tbaReaderIsolation() {
  const middleware = (request, response, next) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (/^\/(?:lire|whisper)\//.test(pathname)) {
      Object.entries(isolationHeaders).forEach(([key, value]) => response.setHeader(key, value));
    }
    if (/^\/whisper\//.test(pathname)) response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  };
  return {
    name: "tba-reader-isolation",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), tbaReaderIsolation()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    https: localHttps,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    https: localHttps,
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
});
