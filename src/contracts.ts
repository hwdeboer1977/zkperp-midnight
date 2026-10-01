// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { pipe } from "effect";
import { managedPath } from "./providers.js";

export type ContractName = "pusdc" | "zkperp" | "leakprobe";

/** The generated module for a contract: `Contract`, `ledger`, `pureCircuits`. */
export async function contractModule(name: ContractName): Promise<any> {
  const file = path.join(managedPath(name), "contract", "index.js");
  if (!fs.existsSync(file) || !fs.existsSync(path.join(managedPath(name), "keys"))) {
    throw new Error(`"${name}" is not compiled with proving keys. Run: npm run compile`);
  }
  return import(file);
}

/** A compiled contract bound to its ZK assets. Neither contract has witnesses. */
export async function loadCompiledContract(name: ContractName) {
  const module = await contractModule(name);
  const compiledContract = pipe(
    CompiledContract.make(name, module.Contract),
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(managedPath(name))
  );
  return { module, compiledContract };
}

// ── deployment.json: where the contracts are ──────────────────────────────
//
// Each address is stored with a fingerprint of the compiled contract module.
// A contract recompiled from changed source is a different contract — its
// verifier keys no longer match the deployed ones — so a changed fingerprint
// means "deploy again", never "reuse".

const DEPLOYMENTS = path.join(process.cwd(), "deployment.json");

interface DeploymentRecord {
  address: string;
  fingerprint: string;
}
type Deployments = Record<string, Partial<Record<ContractName, DeploymentRecord>>>;

function readDeployments(): Deployments {
  return fs.existsSync(DEPLOYMENTS) ? JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8")) : {};
}

export function fingerprint(name: ContractName): string {
  const file = path.join(managedPath(name), "contract", "index.js");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

/** The deployed address, if this network has one built from the current code. */
export function getDeployment(networkId: string, name: ContractName): string | undefined {
  const record = readDeployments()[networkId]?.[name];
  if (!record || typeof record !== "object") return undefined;
  return record.fingerprint === fingerprint(name) ? record.address : undefined;
}

export function saveDeployment(networkId: string, name: ContractName, address: string): void {
  const all = readDeployments();
  all[networkId] = { ...all[networkId], [name]: { address, fingerprint: fingerprint(name) } };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
}
