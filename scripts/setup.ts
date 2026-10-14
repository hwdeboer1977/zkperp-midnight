// SPDX-License-Identifier: Apache-2.0

/**
 * Sets up a stack: a fresh zkperp, priced by Chainlink, with a funded pool,
 * ready for the relayer, the treasury job, the keeper and the frontend. On
 * the network ZKPERP_NETWORK selects (core/network.ts).
 *
 *   npm run setup:local      # the devnet; needs EVM_RPC_URL in .env
 *   npm run setup:preview    # the preview testnet; also needs WALLET_SEED_PREVIEW,
 *                            # funded with tNIGHT from the faucet
 *   npm run relayer -- --signer 1   # and --signer 2, 3: the oracle's three
 *                                   # signers (relayer:preview for preview)
 *   npm run treasury         # in another terminal
 *   npm run keeper -- --keeper 1    # and --keeper 2, 3: three independent
 *                                   # keepers (keeper:preview for preview)
 *
 * On the devnet the dev wallet is pre-funded. On preview it is the operator
 * wallet, from your own secret seed (WALLET_SEED_PREVIEW), separate from any
 * trader's wallet:
 * the first run stops with its address if it holds no tNIGHT, and registers
 * its NIGHT for DUST once it does. The treasury, three keeper and three
 * oracle signer wallets (and, on the devnet only, a command-line trader)
 * derive from it and are funded from it. The oracle signer keys and keeper
 * keys are separate from those wallets (ORACLE_SIGNER_1..3 and
 * KEEPER_SECRET_1..3, or derived; see core/oracle.ts and core/trader.ts).
 *
 * Unlike the demo, which drives a mock price of its own, this deploys zkperp
 * with Chainlink's latest round as its first price, so the relayer can take
 * over from the very next round. Running `npm run demo` afterwards reuses
 * this deployment but sets mock prices; run this again to go back to
 * Chainlink.
 *
 * Writes .zkperp/<network>-stack.json: the addresses, the network endpoints
 * and the treasury's keys — everything the frontend needs to find the
 * contract and pay fees.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { inspect } from "util";
import { SIGNER_SLOTS, oracleSecrets, signerKeys } from "../core/oracle.js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, isLocal, stackFile, walletSeed } from "../core/network.js";
import { buildWallet, getUnshieldedAddress, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { KEEPER_SLOTS, keeperSecrets, keeperWalletSeed, oracleWalletSeed, readyTrader, readyWallet, traderSeed, treasurySeed } from "../core/trader.js";
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

const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fmt = (m: bigint) => `${m / PUSDC}.${(m % PUSDC).toString().padStart(6, "0")}`;

async function main() {
  const rpcUrl = process.env.EVM_RPC_URL;
  if (!rpcUrl) throw new Error("EVM_RPC_URL is not set: add an Ethereum mainnet RPC URL to .env");
  const network = activeNetwork();
  const FILE = stackFile(network);
  setNetworkId(network.networkId);
  const devSeed = walletSeed(network);
  const oracle = oracleSecrets(devSeed);
  console.log(chalk.bold(`zkperp setup on ${network.name}`));

  step("Wallets");
  let dev: BuiltWallet;
  if (isLocal(network)) {
    dev = await buildWallet({ kind: "seed", value: devSeed }, network);
    await waitForSync(dev, () => {});
  } else {
    // Nothing pre-funds a public network's dev wallet: the faucet does.
    const address = getUnshieldedAddress({ kind: "seed", value: devSeed }, network.networkId);
    info(`operator wallet ${address}: syncing (the first time on ${network.name} takes a while)…`);
    dev = await readyWallet(
      async () => {
        throw new Error(
          `the operator wallet holds no tNIGHT. Request some for ${address} at ` +
            "https://midnight-tmnight-preview.nethermind.dev/ and run this again."
        );
      },
      devSeed,
      network,
      info,
      "operator wallet"
    );
  }
  const others: BuiltWallet[] = [];
  try {
    // A command-line trader, for the devnet scripts (demo, race, liquidation).
    // On a public network traders use their own wallets in the browser.
    const traderSeedHex = traderSeed(devSeed);
    const trader = isLocal(network) ? await readyTrader(dev, traderSeedHex, network, info) : null;
    if (trader) others.push(trader);
    const treasury = await readyWallet(dev, treasurySeed(devSeed), network, info, "treasury");
    others.push(treasury);
    // One wallet per keeper, funded now for the same reason as the signers'.
    const keeperWallets: BuiltWallet[] = [];
    for (const slot of KEEPER_SLOTS) {
      keeperWallets.push(await readyWallet(dev, keeperWalletSeed(devSeed, slot), network, info, `keeper ${slot + 1}`));
    }
    others.push(...keeperWallets);
    // One wallet per oracle signer, funded now: three relayers starting at
    // once would otherwise all fund themselves from the dev wallet together.
    const signerWallets: BuiltWallet[] = [];
    for (const slot of SIGNER_SLOTS) {
      signerWallets.push(await readyWallet(dev, oracleWalletSeed(devSeed, slot), network, info, `oracle signer ${slot + 1}`));
    }
    others.push(...signerWallets);
    info(`dev      ${dev.unshieldedAddress}`);
    if (trader) info(`trader   ${trader.unshieldedAddress}`);
    info(`treasury ${treasury.unshieldedAddress}`);
    keeperWallets.forEach((w, slot) => info(`keeper ${slot + 1} ${w.unshieldedAddress}`));
    signerWallets.forEach((w, slot) => info(`signer ${slot + 1} ${w.unshieldedAddress}`));

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
        signerKeys(module.pureCircuits, oracle),
        price,
        round.updatedAt,
        round.roundId,
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
        keeperSecrets(devSeed).map((x) => module.pureCircuits.liquidatorPublicKey(x)),
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

    if (trader && (await balance(trader, usdc)) < TRADER_MINT) {
      step("Trader");
      info(`trader mints ${fmt(TRADER_MINT)} pUSDC…`);
      const traderPusdc = await handle(trader, traderSeedHex, "pusdc", pusdcAddress);
      await traderPusdc.deployed.callTx.mint(TRADER_MINT);
    }

    const stack = {
      network: {
        networkId: network.networkId,
        nodeWS: network.nodeWS,
        indexer: network.indexer,
        indexerWS: network.indexerWS,
        proofServer: network.proofServer,
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
    console.log(`\n${chalk.green.bold(`${network.name} stack ready.`)} ${chalk.gray(FILE)}`);
    const suffix = isLocal(network) ? "" : `:${network.key}`;
    console.log(chalk.gray(`   next: npm run relayer${suffix} -- --signer 1 (and 2, 3), treasury${suffix}, and keeper${suffix} -- --keeper 1 (and 2, 3), each in its own terminal`));
  } finally {
    for (const w of others) await w.facade.stop();
    await dev.facade.stop();
  }
}

main().catch((error) => {
  // A submission error names nothing itself; the node's reason is in its
  // causes ("1010: … would exhaust the block limits"), which inspect prints.
  console.error(chalk.red(`\n✗ ${error?.cause ? inspect(error, { depth: 8 }) : error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
