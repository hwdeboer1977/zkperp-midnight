// SPDX-License-Identifier: Apache-2.0

/**
 * Positive control for the privacy search: does it find values that ARE public?
 *
 *   npm run probe:leak
 *
 * Deploys the test-only `leakprobe` contract, calls it with three distinctive
 * amounts it discloses on purpose, and runs the same search the privacy checks
 * use over that call's raw transaction. Every amount must be found. Reports
 * which encodings matched, which is how you learn what the chain actually
 * uses — and so what a "not found" elsewhere is worth.
 */

import chalk from "chalk";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "./network.js";
import { buildWallet, makeWalletProviders, waitForSync } from "./wallet.js";
import { makeProviders } from "./providers.js";
import { loadCompiledContract } from "./contracts.js";
import { findNumber, rawTransaction } from "./leak-search.js";

// Same magnitudes as the demo's collateral and size, and a Uint<128>-sized
// one, so the control exercises the widths the real search relies on.
const A = 1_234_567_893n;
const B = 12_345_678_917n;
const C = 987_654_321_123n;

async function main() {
  setNetworkId(LOCAL.networkId);
  const seed = walletSeed();
  const wallet = await buildWallet({ kind: "seed", value: seed }, LOCAL);
  try {
    await waitForSync(wallet, () => {});
    const { walletProvider, midnightProvider } = makeWalletProviders(wallet);
    const providers: any = makeProviders({
      contractName: "leakprobe",
      network: LOCAL,
      seedHex: seed,
      accountId: wallet.unshieldedAddress,
      walletProvider,
      midnightProvider,
    });
    const { compiledContract } = await loadCompiledContract("leakprobe");
    console.log(chalk.gray("deploying leakprobe…"));
    const deployed: any = await deployContract(providers, { compiledContract, args: [] } as any);
    console.log(chalk.gray("calling leak(a, b, c)…"));
    const tx = await deployed.callTx.leak(A, B, C);
    const raw = await rawTransaction(LOCAL.indexer, tx.public.txHash);
    console.log(chalk.gray(`searching ${raw.length / 2} bytes of raw transaction\n`));

    let missed = 0;
    for (const [label, n] of [
      ["a: Uint<64> ledger write", A],
      ["b: Uint<128> ledger write", B],
      ["c: Set<Uint<64>> key", C],
    ] as const) {
      const forms = findNumber(raw, n);
      if (forms.length === 0) missed += 1;
      console.log(
        `   ${forms.length ? chalk.green("✓ found") : chalk.red("✗ MISSED")}  ${label} (${n})` +
          (forms.length ? chalk.gray(`  as ${forms.join(", ")}`) : "")
      );
    }
    console.log();
    if (missed) {
      console.log(chalk.red.bold(`The search is blind to ${missed} disclosed value(s). Its "not found" results cannot be trusted.`));
      process.exitCode = 1;
    } else {
      console.log(chalk.green.bold("The search finds every deliberately disclosed value."));
    }
  } finally {
    await wallet.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
