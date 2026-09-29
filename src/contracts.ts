// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import path from "path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { pipe } from "effect";
import { managedPath } from "./providers.js";

export type ContractName = "pusdc" | "zkperp";

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

const DEPLOYMENTS = path.join(process.cwd(), "deployment.json");

type Deployments = Record<string, Partial<Record<ContractName, string>>>;

function readDeployments(): Deployments {
  return fs.existsSync(DEPLOYMENTS) ? JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8")) : {};
}

export function getDeployment(networkId: string, name: ContractName): string | undefined {
  return readDeployments()[networkId]?.[name];
}

export function saveDeployment(networkId: string, name: ContractName, address: string): void {
  const all = readDeployments();
  all[networkId] = { ...all[networkId], [name]: address };
  fs.writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
}
