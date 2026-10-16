// SPDX-License-Identifier: Apache-2.0

// Unit tests of the frontend's logic (test/), outside the browser: `@core`
// resolves as in vite.config.ts; happy-dom stands in for `window`, and
// fake-indexeddb for the position store.

import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "isomorphic-ws": path.resolve(__dirname, "src/shims/isomorphic-ws.ts"),
      "@core": path.resolve(__dirname, "../core"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["fake-indexeddb/auto"],
    testTimeout: 60_000,
  },
});
