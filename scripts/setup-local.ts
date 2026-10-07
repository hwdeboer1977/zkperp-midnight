// SPDX-License-Identifier: Apache-2.0

/**
 * Sets up the local stack: a fresh zkperp on the devnet, priced by Chainlink,
 * with a funded pool, ready for the relayer, the treasury job and the
 * frontend.
 *
 *   npm run setup:local      # needs EVM_RPC_URL in .env
 *   npm run relayer          # in one terminal
 *   npm run treasury         # in another
 *
 * Unlike the demo, which drives a mock price of its own, this deploys zkperp
 * with Chainlink's latest round as its first price, so the relayer can take
 * over from the very next round. Running `npm run demo` afterwards reuses
 * this deployment but sets mock prices; run this again to go back to
 * Chainlink.
 *
 * Writes .zkperp/local-stack.json: the addresses, the network endpoints and
 * the treasury's keys — everything the frontend needs to find the contract
 * and pay fees.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "../core/network.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { keeperSeed, liquidatorSecret, readyTrader, readyWallet, traderSeed, treasurySeed } from "../core/trader.js";
import { readLedger, type ContractHandle } from "../core/perp.js";
import { addLiquidity } from "../core/pool.js";
import { balance, coinKey, deployOrFind, handle, waitForBalance } from "../core/session.js";
import { ETH_USD_MAINNET, latestRound, toSixDecimals } from "../core/chainlink.js";

const PUSDC = 1_000_000n;
const LIQUIDITY = 500_000n * PUSDC;
const DEV_MINT = 1_000_000n * PUSDC;
const TRADER_MINT = 10_000n * PUSDC;

/** zkperp's deploy-time parameters for the local stack. */
const PARAMS = {
  maxLeverage: 20n,
  minCollateral: 10n * PUSDC,
  maxPayout: 5_000n * PUSDC,
  openFeeBps: 10n,
  closeFeeBps: 10n,
  // 0.01% of size an hour, in 10^-12 of size per second.
  borrowRate: 27_778n,
  clockSlack: 600n,
  // Just above Chainlink's hourly heartbeat.
  maxPriceAge: 3_900n,
  // Liquidatable below 2.5% of size in equity; 0.5% of size to the treasury.
  maintenanceBps: 250n,
  liquidationFeeBps: 50n,
};

const FILE = path.join(process.cwd(), ".zkperp", "local-stack.json");
const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fmt = (m: bigint) => `${m / PUSDC}.${(m % PUSDC).toString().padStart(6, "0")}`;

async function main() {
  const rpcUrl = process.env.EVM_RPC_URL;
  if (!rpcUrl) throw new Error("EVM_RPC_URL is not set: add an Ethereum mainnet RPC URL to .env");
  setNetworkId(LOCAL.networkId);
  const devSeed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${devSeed}`).digest();

  step("Wallets");
  const dev = await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
  const others: BuiltWallet[] = [];
  try {
    await waitForSync(dev, () => {});
    const traderSeedHex = traderSeed(devSeed);
    const trader = await readyTrader(dev, traderSeedHex, LOCAL, info);
    others.push(trader);
    const treasury = await readyWallet(dev, treasurySeed(devSeed), LOCAL, info, "treasury");
    others.push(treasury);
    const keeper = await readyWallet(dev, keeperSeed(devSeed), LOCAL, info, "keeper");
    others.push(keeper);
    info(`dev      ${dev.unshieldedAddress}`);
    info(`trader   ${trader.unshieldedAddress}`);
    info(`treasury ${treasury.unshieldedAddress}`);
    info(`keeper   ${keeper.unshieldedAddress}`);

    step("pUSDC");
    const pusdcAddress = await deployOrFind(info, dev, devSeed, "pusdc", async () => []);
    const devPusdc = await handle(dev, devSeed, "pusdc", pusdcAddress);
    if ((await readLedger(devPusdc)).totalSupply === 0n) await devPusdc.deployed.callTx.mint(DEV_MINT);
    const usdc: Uint8Array = (await readLedger(devPusdc)).tokenId;
    if ((await balance(dev, usdc)) < LIQUIDITY) {
      info(`dev mints ${fmt(DEV_MINT)} pUSDC…`);
      await devPusdc.deployed.callTx.mint(DEV_MINT);
    }
    info(`pUSDC ${pusdcAddress}`);

    step("Chainlink");
    const round = await latestRound(rpcUrl, ETH_USD_MAINNET);
    const price = toSixDecimals(round.answer, round.decimals);
    info(`${round.description} round ${round.roundId}: $${fmt(price)}, published ${Math.floor(Date.now() / 1000) - Number(round.updatedAt)}s ago`);

    step("zkperp, fresh");
    const perpAddress = await deployOrFind(
      info,
      dev,
      devSeed,
      "zkperp",
      async (module) => [
        usdc,
        module.pureCircuits.adminKey(adminSecret),
        price,
        round.updatedAt,
        PARAMS.maxLeverage,
        PARAMS.minCollateral,
        PARAMS.maxPayout,
        PARAMS.openFeeBps,
        PARAMS.closeFeeBps,
        PARAMS.borrowRate,
        { bytes: coinKey(treasury) },
        PARAMS.clockSlack,
        PARAMS.maxPriceAge,
        PARAMS.maintenanceBps,
        PARAMS.liquidationFeeBps,
        module.pureCircuits.liquidatorPublicKey(liquidatorSecret(devSeed)),
      ],
      () => false
    );
    info(`zkperp ${perpAddress}`);
    const perp: ContractHandle = await handle(dev, devSeed, "zkperp", perpAddress);

    step("Liquidity");
    await waitForBalance(dev, usdc, (b) => b >= LIQUIDITY);
    info(`dev adds ${fmt(LIQUIDITY)} pUSDC…`);
    await addLiquidity(perp, usdc, LIQUIDITY);
    const l = await readLedger(perp);
    info(`pool ${fmt(l.poolValue)} pUSDC: ${l.freeSlots} slots of ${fmt(l.maxPayout)}`);

    step("Trader");
    if ((await balance(trader, usdc)) < TRADER_MINT) {
      info(`trader mints ${fmt(TRADER_MINT)} pUSDC…`);
      const traderPusdc = await handle(trader, traderSeedHex, "pusdc", pusdcAddress);
      await traderPusdc.deployed.callTx.mint(TRADER_MINT);
    }

    const stack = {
      network: {
        networkId: LOCAL.networkId,
        nodeWS: LOCAL.nodeWS,
        indexer: LOCAL.indexer,
        indexerWS: LOCAL.indexerWS,
        proofServer: LOCAL.proofServer,
      },
      contracts: { pusdc: pusdcAddress, zkperp: perpAddress },
      usdcToken: hex(usdc),
      treasury: {
        coinPublicKey: hex(coinKey(treasury)),
        encryptionPublicKey: String(treasury.shieldedSecretKeys.encryptionPublicKey),
      },
      oracle: { feed: ETH_USD_MAINNET, description: round.description },
      params: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.toString()])),
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify(stack, null, 2) + "\n");
    console.log(`\n${chalk.green.bold("Local stack ready.")} ${chalk.gray(FILE)}`);
    console.log(chalk.gray("   next: npm run relayer, and npm run treasury, each in its own terminal"));
  } finally {
    for (const w of others) await w.facade.stop();
    await dev.facade.stop();
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
