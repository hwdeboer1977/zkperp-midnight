// SPDX-License-Identifier: Apache-2.0

/**
 * Gives the frontend what it needs from the backend side of the repository.
 *
 *   npm run frontend:config     # after npm run setup:local (and npm run compile)
 *
 *   frontend/src/generated/<contract>/   the compiled contract modules
 *   frontend/public/zk/<contract>/       proving and verifier keys, ZKIR
 *   frontend/public/config.json          network, addresses, treasury keys
 *
 * The contract modules are COPIED, not imported from contracts/managed: an
 * import from outside frontend/ would resolve a second compact-runtime from
 * the root node_modules, and two runtimes mean two WASM instances whose
 * values do not recognise each other. (Learned in midnight-polisZK.)
 *
 * `zkVersion` in config.json is the contract's fingerprint. The frontend adds
 * it to every key URL, so a browser that cached one deployment's keys cannot
 * prove against the next deployment's verifier keys.
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { fingerprint, type ContractName } from "../core/contracts.js";

const ROOT = process.cwd();
const FRONTEND = path.join(ROOT, "frontend");
const STACK = path.join(ROOT, ".zkperp", "local-stack.json");
const CONTRACTS: ContractName[] = ["zkperp", "pusdc"];

function copyTree(from: string, to: string, keep: (file: string) => boolean = () => true): number {
  let copied = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copied += copyTree(source, target, keep);
    else if (keep(entry.name)) {
      fs.copyFileSync(source, target);
      copied += 1;
    }
  }
  return copied;
}

function main() {
  if (!fs.existsSync(STACK)) throw new Error("no local stack: run npm run setup:local first");
  const stack = JSON.parse(fs.readFileSync(STACK, "utf8"));

  for (const name of CONTRACTS) {
    const managed = path.join(ROOT, "contracts", "managed", name);
    if (!fs.existsSync(path.join(managed, "keys"))) throw new Error(`${name} has no proving keys: run npm run compile`);

    const generated = path.join(FRONTEND, "src", "generated", name);
    fs.rmSync(generated, { recursive: true, force: true });
    copyTree(path.join(managed, "contract"), generated);

    // Stale keys from an earlier compile must not linger next to new ones.
    const zk = path.join(FRONTEND, "public", "zk", name);
    fs.rmSync(zk, { recursive: true, force: true });
    const keys = copyTree(path.join(managed, "keys"), path.join(zk, "keys"));
    const zkir = copyTree(path.join(managed, "zkir"), path.join(zk, "zkir"), (f) => f.endsWith(".bzkir"));
    copyTree(path.join(managed, "compiler"), path.join(zk, "compiler"));
    console.log(chalk.gray(`   ${name}: contract module, ${keys} key files, ${zkir} ZKIR files`));
  }

  const config = {
    ...stack,
    zkVersion: fingerprint("zkperp"),
    // Same-origin paths; the dev server proxies them to the services (see
    // frontend/vite.config.ts), so the browser needs no CORS.
    services: { relayer: "/svc/relayer", treasury: "/svc/treasury" },
  };
  fs.writeFileSync(path.join(FRONTEND, "public", "config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(chalk.green(`frontend configured for zkperp ${stack.contracts.zkperp.slice(0, 12)}… on ${stack.network.networkId}`));
}

main();
