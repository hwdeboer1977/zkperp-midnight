// SPDX-License-Identifier: Apache-2.0

import path from "path";
import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

// compact-runtime's sourcemaps, and the compiled contract's, point at files
// that are not shipped; harmless noise. Vite reports them through warnOnce.
const logger = createLogger();
const noise = (msg: string) => msg.includes("points to missing source files");
const { warn, warnOnce } = logger;
logger.warn = (msg, options) => noise(msg) || warn(msg, options);
logger.warnOnce = (msg, options) => noise(msg) || warnOnce(msg, options);

export default defineConfig({
  customLogger: logger,
  // The Compact runtime ships wasm-bindgen's bundler target: it imports its
  // .wasm directly and initialises it with top-level await. Targeting esnext
  // keeps the await; esbuild's dependency pre-bundling cannot handle the wasm
  // import, so the runtime is excluded from it. (Settings from midnight-polisZK.)
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      "isomorphic-ws": path.resolve(__dirname, "src/shims/isomorphic-ws.ts"),
      assert: path.resolve(__dirname, "src/shims/assert.ts"),
      // The one copy of zkperp's arithmetic, shared with the services and tests.
      "@core": path.resolve(__dirname, "../core"),
    },
  },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@midnight-ntwrk/compact-runtime", "@midnight-ntwrk/onchain-runtime-v3"],
    // A CJS dependency of compact-runtime; excluding the runtime skips it too.
    include: ["object-inspect"],
    esbuildOptions: { target: "esnext" },
  },
  server: {
    port: 5173,
    host: true, // reachable from the Windows browser under WSL2
    fs: { allow: [".", "../core"] },
    // The services, same-origin so the browser needs no CORS.
    proxy: {
      "/svc/relayer": { target: "http://127.0.0.1:3010", rewrite: (p) => p.replace(/^\/svc\/relayer/, "") },
      "/svc/treasury": { target: "http://127.0.0.1:3011", rewrite: (p) => p.replace(/^\/svc\/treasury/, "") },
      "/svc/keeper": { target: "http://127.0.0.1:3012", rewrite: (p) => p.replace(/^\/svc\/keeper/, "") },
    },
  },
});
