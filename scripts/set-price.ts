// SPDX-License-Identifier: Apache-2.0

/**
 * Sets the mark price by hand, as the oracle admin: to test liquidations on a
 * network whose price comes from Chainlink.
 *
 *   npm run price:preview -- 2370        # dollars
 *
 * Stop the relayer first: it submits from the same operator wallet, and would
 * race this transaction. The price is stamped with the current time, so when
 * the relayer restarts it waits for a Chainlink round newer than that (at most
 * an hour for ETH/USD) before the market price returns. Until then every open
 * and close on this deployment prices at the price set here.
 */

import "dotenv/config";
import chalk from "chalk";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync } from "../core/wallet.js";
import { getDeployment } from "../core/contracts.js";
import { readLedger, submitPrice } from "../core/perp.js";
import { handle } from "../core/session.js";

const fmt = (m: bigint) => `$${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;

function parseDollars(text: string | undefined): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text ?? "");
  if (!match) throw new Error("usage: npm run price:preview -- <dollars>, e.g. 2370 or 2370.50");
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

async function main() {
  const price = parseDollars(process.argv[2]);
  const network = activeNetwork();
  setNetworkId(network.networkId);
  const perpAddress = getDeployment(network.networkId, "zkperp");
  if (!perpAddress) throw new Error(`no current zkperp deployment on ${network.name}: run the setup first`);

  const seed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${seed}`).digest();
  console.log(chalk.gray("syncing the operator wallet…"));
  const wallet = await buildWallet({ kind: "seed", value: seed }, network);
  try {
    await waitForSync(wallet, () => {});
    const perp = await handle(wallet, seed, "zkperp", perpAddress);
    const before = await readLedger(perp);
    console.log(chalk.gray(`zkperp ${perpAddress.slice(0, 12)}… on ${network.name}: ${fmt(before.markPrice)} → ${fmt(price)}`));
    const txHash = await submitPrice(perp, price, adminSecret);
    console.log(chalk.green(`set ${fmt(price)} in ${txHash}`));
    console.log(chalk.gray("restart the relayer when done; it resumes at the next Chainlink round"));
  } finally {
    await wallet.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
