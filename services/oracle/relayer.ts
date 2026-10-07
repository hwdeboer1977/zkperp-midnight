// SPDX-License-Identifier: Apache-2.0

/**
 * The price relayer: Chainlink ETH/USD → zkperp's `setPrice`.
 *
 *   npm run relayer          # needs EVM_RPC_URL in .env
 *
 * Polls the feed and submits only when Chainlink publishes a NEW round — a
 * 0.5% move or the hourly heartbeat. Pricing in zkperp is strict: a trade
 * proven at one price fails if the price changes before it lands. Submitting
 * only real rounds keeps those failures to real price moves; re-stamping the
 * same price every few seconds would starve every trader.
 *
 * Each price carries the round's own `updatedAt`, which the contract checks
 * against its maximum price age. The relayer never sets a time of its own.
 *
 * Locally the oracle secret is the dev wallet's admin secret, as in the demo,
 * and the relayer uses the dev wallet. Do not run it alongside `npm run demo`
 * or `npm run race`: they set prices themselves.
 *
 * GET http://127.0.0.1:3010/health reports the last round and the price age.
 */

import "dotenv/config";
import http from "http";
import chalk from "chalk";
import { createHash } from "crypto";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, stackFile, walletSeed } from "../../core/network.js";
import { buildWallet, waitForSync } from "../../core/wallet.js";
import { getDeployment } from "../../core/contracts.js";
import { readLedger, submitPrice } from "../../core/perp.js";
import { handle } from "../../core/session.js";
import { ETH_USD_MAINNET, latestRound, toSixDecimals, type Round } from "../../core/chainlink.js";

const POLL_MS = Number(process.env.RELAYER_POLL_MS ?? 15_000);
const PORT = Number(process.env.RELAYER_PORT ?? 3010);
const FEED = process.env.CHAINLINK_FEED ?? ETH_USD_MAINNET;

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fmt = (p: bigint) => `$${p / 1_000_000n}.${(p % 1_000_000n).toString().padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Health {
  feed: string;
  contract: string;
  lastRound?: { roundId: string; price: string; updatedAt: number };
  contractPrice?: { price: string; priceTime: number; ageSeconds: number; maxAgeSeconds: number };
  lastSubmission?: { roundId: string; txHash: string; at: string };
  lastError?: { message: string; at: string };
  submissions: number;
}

async function main() {
  const rpcUrl = process.env.EVM_RPC_URL;
  if (!rpcUrl) throw new Error("EVM_RPC_URL is not set: add an Ethereum mainnet RPC URL to .env");
  const network = activeNetwork();
  setNetworkId(network.networkId);
  const perpAddress = getDeployment(network.networkId, "zkperp");
  if (!perpAddress) throw new Error(`no current zkperp deployment on ${network.name}: run the setup first`);

  const seed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${seed}`).digest();
  log("syncing the oracle wallet…");
  const wallet = await buildWallet({ kind: "seed", value: seed }, network);
  await waitForSync(wallet, () => {});
  const perp = await handle(wallet, seed, "zkperp", perpAddress);

  const health: Health = { feed: FEED, contract: perpAddress, submissions: 0 };
  const server = http
    .createServer((req, res) => {
      if (req.url !== "/health") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health, null, 2));
    })
    .listen(PORT, "127.0.0.1");
  log(`relaying ${FEED} to zkperp ${perpAddress.slice(0, 12)}…, health on http://127.0.0.1:${PORT}/health`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastSubmitted: bigint | undefined;
  let waitingNoted: bigint | undefined;
  while (!stopping) {
    try {
      const round: Round = await latestRound(rpcUrl, FEED);
      const price = toSixDecimals(round.answer, round.decimals);
      health.lastRound = { roundId: round.roundId.toString(), price: fmt(price), updatedAt: Number(round.updatedAt) };

      const ledger = await readLedger(perp);
      const now = Math.floor(Date.now() / 1000);
      health.contractPrice = {
        price: fmt(ledger.markPrice),
        priceTime: Number(ledger.priceTime),
        ageSeconds: now - Number(ledger.priceTime),
        maxAgeSeconds: Number(ledger.maxPriceAge),
      };

      if (round.roundId === lastSubmitted) {
        // Nothing new from Chainlink.
      } else if (round.updatedAt < ledger.priceTime) {
        // The contract holds a newer price than this round — set by the demo's
        // mock oracle, say. The contract refuses older rounds, so wait.
        if (waitingNoted !== round.roundId) {
          log(`round ${round.roundId} (${fmt(price)}) is older than the contract's price; waiting for a newer round`);
          waitingNoted = round.roundId;
        }
      } else if (round.updatedAt === ledger.priceTime && price === ledger.markPrice) {
        lastSubmitted = round.roundId; // already on chain, e.g. after a restart
      } else {
        log(`new round ${round.roundId}: ${fmt(price)}, published ${now - Number(round.updatedAt)}s ago — submitting…`);
        const txHash = await submitPrice(perp, price, adminSecret, round.updatedAt);
        lastSubmitted = round.roundId;
        health.submissions += 1;
        health.lastSubmission = { roundId: round.roundId.toString(), txHash, at: new Date().toISOString() };
        log(chalk.green(`   set ${fmt(price)} in ${txHash}`));
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      health.lastError = { message, at: new Date().toISOString() };
      log(chalk.red(`error: ${message}`));
    }
    for (let waited = 0; waited < POLL_MS && !stopping; waited += 500) await sleep(500);
  }

  log("stopping…");
  server.close();
  await wallet.facade.stop();
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
