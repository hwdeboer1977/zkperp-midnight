// SPDX-License-Identifier: Apache-2.0

/**
 * Which ledger operations conflict between concurrent transactions?
 *
 *   npm run compile:probe && npm run probe:race
 *
 * Deploys the test-only `raceprobe` contract and, for each pair below, has
 * the dev and trader wallets call it at the same moment. Both calls are
 * proven against the same state; the question is whether the second to land
 * still applies. The answer decides how zkperp must lay out the state that
 * every trade touches (see `npm run race` for zkperp itself).
 *
 * The first pair is the control: two writes to DIFFERENT fields. If those
 * conflict, conflicts are per contract and no layout can help.
 */

import chalk from "chalk";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { randomBytes } from "crypto";
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { loadCompiledContract } from "../core/contracts.js";
import { readyTrader, traderSeed } from "../core/trader.js";
import { readLedger, type ContractHandle } from "../core/perp.js";
import { handle, providersFor } from "../core/session.js";

type Call = (c: ContractHandle) => Promise<any>;

const call = (circuit: string, ...args: Array<() => unknown[]>): Call => async (c) =>
  c.deployed.callTx[circuit](...args.flatMap((f) => f()));
const fresh32 = () => [new Uint8Array(randomBytes(32))];

/** [label, dev's call, trader's call] */
const PAIRS: Array<[string, Call, Call]> = [
  ["control: read-modify-write of two different cells", call("rmwA"), call("rmwB")],
  ["read-modify-write of the same cell (zkperp's `reserved`)", call("rmwA"), call("rmwA")],
  ["blind writes to the same cell", call("writeA", () => [7n]), call("writeA", () => [9n])],
  ["a read of a cell against a write of it (a trade against a price update)", call("readA"), call("rmwA")],
  ["two counter increments", call("increment"), call("increment")],
  ["two lessThan-checked counter increments", call("checkedIncrement"), call("checkedIncrement")],
  ["a lessThan check against a counter increment", call("checkCounter"), call("increment")],
  ["two increments after reading the exact counter value", call("readIncrement"), call("readIncrement")],
  ["two Merkle tree inserts", call("insertLeaf", fresh32), call("insertLeaf", fresh32)],
  ["two set inserts of different keys", call("insertKey", fresh32), call("insertKey", fresh32)],
  ["two map writes to different keys", call("writeSlot", fresh32, () => [1n]), call("writeSlot", fresh32, () => [2n])],
  ["two member-checked inserts of different keys (nullifiers)", call("checkInsertKey", fresh32), call("checkInsertKey", fresh32)],
  // The leaf inserted by an earlier pair; its path is taken from the ledger at call time.
  ["a tree root check against a tree insert (a close against an open)", async (c) => {
    if (!firstLeaf) throw new Error("no leaf to prove");
    const path = (await readLedger(c)).tree.findPathForLeaf(firstLeaf);
    return c.deployed.callTx.checkRoot(path);
  }, call("insertLeaf", fresh32)],
];

/** A known leaf, inserted before the root-check pair. */
let firstLeaf: Uint8Array | undefined;

interface Result {
  ok: boolean;
  ms: number;
  why: string;
}

async function attempt(c: ContractHandle, f: Call): Promise<Result> {
  const start = Date.now();
  try {
    await f(c);
    return { ok: true, ms: Date.now() - start, why: "" };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const status = message.match(/"status":\s*"(\w+)"/)?.[1];
    const why = status ?? (/SubmissionError/.test(message) ? "rejected before inclusion" : message.slice(0, 160));
    return { ok: false, ms: Date.now() - start, why };
  }
}

async function main() {
  setNetworkId(LOCAL.networkId);
  const devSeed = walletSeed();
  const devWallet = await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
  let traderWallet: BuiltWallet | null = null;
  const rows: Array<[string, Result, Result]> = [];
  try {
    await waitForSync(devWallet, () => {});
    const traderSeedHex = traderSeed(devSeed);
    traderWallet = await readyTrader(devWallet, traderSeedHex, LOCAL, (s) => console.log(chalk.gray(`   ${s}`)));

    const { compiledContract } = await loadCompiledContract("raceprobe");
    console.log(chalk.gray("deploying raceprobe…"));
    const deployed: any = await deployContract(providersFor(devWallet, devSeed, "raceprobe") as any, {
      compiledContract: compiledContract as any,
      args: [],
    } as any);
    const address: string = deployed.deployTxData.public.contractAddress;
    const dev = await handle(devWallet, devSeed, "raceprobe", address);
    const trader = await handle(traderWallet, traderSeedHex, "raceprobe", address);

    firstLeaf = new Uint8Array(randomBytes(32));
    await dev.deployed.callTx.insertLeaf(firstLeaf);

    for (const [label, devCall, traderCall] of PAIRS) {
      console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(label)}`);
      const [d, t] = await Promise.all([attempt(dev, devCall), attempt(trader, traderCall)]);
      for (const [who, r] of [["dev", d], ["trader", t]] as const) {
        console.log(
          `   ${r.ok ? chalk.green("landed") : chalk.red("failed")} ${who} after ${(r.ms / 1000).toFixed(1)}s` +
            (r.why ? chalk.gray(`  (${r.why})`) : "")
        );
      }
      rows.push([label, d, t]);
    }

    const l = await readLedger(dev);
    console.log(chalk.gray(`\n   final: cellA ${l.cellA}, cellB ${l.cellB}, counter ${l.counter}`));
    console.log(`\n${chalk.bold("Conflict table")}`);
    for (const [label, d, t] of rows) {
      const verdict = d.ok && t.ok ? chalk.green("both land   ") : d.ok || t.ok ? chalk.red("conflict    ") : chalk.yellow("both failed ");
      console.log(`   ${verdict} ${label}`);
    }
  } finally {
    await traderWallet?.facade.stop();
    await devWallet.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
