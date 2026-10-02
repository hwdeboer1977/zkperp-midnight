// SPDX-License-Identifier: Apache-2.0

/**
 * Sends NIGHT from the devnet's pre-funded dev wallet to a browser wallet, so
 * it can generate DUST and pay fees on the local devnet.
 *
 *   npm run fund -- mn_addr_undeployed1…            # 5 NIGHT
 *   npm run fund -- mn_addr_undeployed1… 20000000   # an amount in NIGHT's smallest unit
 *
 * Copy the unshielded address from the wallet (1AM or Lace, set to the
 * Undeployed network). After it arrives, register the NIGHT for DUST
 * generation in the wallet. pUSDC then comes from the frontend's Faucet page.
 */

import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync } from "../core/wallet.js";
import { sendNight } from "../core/trader.js";

async function main() {
  const [address, amountText] = process.argv.slice(2);
  if (!address?.startsWith(`mn_addr_${LOCAL.networkId}1`)) {
    throw new Error(`usage: npm run fund -- mn_addr_${LOCAL.networkId}1… [amount]  (the wallet's unshielded address)`);
  }
  const amount = BigInt(amountText ?? 5_000_000);
  setNetworkId(LOCAL.networkId);
  const dev = await buildWallet({ kind: "seed", value: walletSeed() }, LOCAL);
  try {
    await waitForSync(dev, () => {});
    console.log(chalk.gray(`sending ${amount} NIGHT to ${address}…`));
    const txId = await sendNight(dev, address, amount, LOCAL);
    console.log(chalk.green(`sent: ${txId}`));
    console.log(chalk.gray("next: register the NIGHT for DUST generation in the wallet, then mint pUSDC on the Faucet page"));
  } finally {
    await dev.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
