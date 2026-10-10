// SPDX-License-Identifier: Apache-2.0

/**
 * Records proving requests, to replay them on other machines (bench/replay.sh).
 *
 *   node bench/capture-proxy.mjs                  # :6301 → http://127.0.0.1:6300
 *   PROOF_SERVER_URL=http://127.0.0.1:6301 npm run stoploss
 *
 * A proxy in front of the proof server: every request is forwarded
 * unchanged, and the body of each POST to /prove or /check is saved as
 * bench/captures/<n>_<path>_<MB>.bin, with a line in index.jsonl (path,
 * content type, size, and how long the proof server took). The proof server
 * keeps no state between requests and midnight-js sends the circuit's key
 * material with each one, so a saved body proves the same anywhere: no chain,
 * wallet or Node app needed, only the proof server and curl.
 *
 * Environment: CAPTURE_PORT (6301), UPSTREAM (http://127.0.0.1:6300),
 * CAPTURE_DIR (bench/captures).
 */

import fs from "fs";
import http from "http";
import path from "path";

const PORT = Number(process.env.CAPTURE_PORT ?? 6301);
const UPSTREAM = new URL(process.env.UPSTREAM ?? "http://127.0.0.1:6300");
const DIR = process.env.CAPTURE_DIR ?? path.join(path.dirname(new URL(import.meta.url).pathname), "captures");
fs.mkdirSync(DIR, { recursive: true });
let n = fs.readdirSync(DIR).filter((f) => f.endsWith(".bin")).length;

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const started = Date.now();
      const up = http.request(
        { host: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method, headers: { ...req.headers, host: UPSTREAM.host } },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
          upRes.on("end", () => {
            const seconds = (Date.now() - started) / 1000;
            const route = (req.url ?? "/").split("?")[0];
            if (req.method !== "POST" || !/^\/(prove|check)$/.test(route)) return;
            n += 1;
            const mb = (body.length / 1e6).toFixed(1);
            const file = `${String(n).padStart(3, "0")}_${route.slice(1)}_${mb}MB.bin`;
            fs.writeFileSync(path.join(DIR, file), body);
            const entry = { file, path: route, contentType: req.headers["content-type"] ?? "", bytes: body.length, status: upRes.statusCode, seconds };
            fs.appendFileSync(path.join(DIR, "index.jsonl"), JSON.stringify(entry) + "\n");
            console.log(`${file}  ${route}  ${mb} MB  ${upRes.statusCode}  ${seconds.toFixed(1)} s`);
          });
        }
      );
      up.on("error", (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      up.end(body);
    });
  })
  .listen(PORT, () => console.log(`capturing on :${PORT} → ${UPSTREAM.href}, into ${DIR}`));
