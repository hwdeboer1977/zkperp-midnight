// Copyright 2026 Henk Wim de Boer
// SPDX-License-Identifier: Apache-2.0

/**
 * `isomorphic-ws` browser build exports only a default, but
 * `midnight-js-indexer-public-data-provider` imports it as a NAMED export:
 *
 *   import { WebSocket } from "isomorphic-ws"
 *
 * Rollup warns about this at build time ("WebSocket is not exported by ...")
 * and then emits `undefined`, so the indexer's websocket subscription dies the
 * first time it tries to construct one — which is during a contract call, well
 * after the point where a clear error would have been useful.
 *
 * Aliased in vite.config.ts so both import styles resolve to the browser's own
 * WebSocket.
 */
const ws = globalThis.WebSocket;

export { ws as WebSocket };
export default ws;
