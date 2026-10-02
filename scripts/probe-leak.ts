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
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, makeWalletProviders, waitForSync } from "../core/wallet.js";
import { makeProviders } from "../core/providers.js";
import { loadCompiledContract } from "../core/contracts.js";
import { encodings, findNumber, rawTransaction } from "../core/leak-search.js";

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
      // The bytes around every occurrence: how the chain frames an amount.
      for (const e of encodings(n)) {
        for (let i = raw.indexOf(e.hex); i >= 0; i = raw.indexOf(e.hex, i + 1)) {
          if (i % 2) continue;
          const before = raw.slice(Math.max(0, i - 24), i);
          const after = raw.slice(i + e.hex.length, i + e.hex.length + 24);
          console.log(chalk.gray(`        ${e.form} at byte ${i / 2}: ${before} [${e.hex}] ${after}`));
        }
      }
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
