// SPDX-License-Identifier: Apache-2.0

/**
 * The treasury job: pays the LPs their share of fees, one epoch at a time.
 *
 *   npm run treasury
 *
 * Every fee reaches the treasury wallet as a shielded output, so its balance
 * is fees and nothing else. Each market (core/markets.ts) pays its own
 * treasury wallet, so each wallet's fees belong to one pool; this job runs
 * them all, one after the other. An epoch deposits the LPs' share of the fees
 * received since the last epoch into the pool with `depositFees`; the rest is
 * the protocol's and stays in the wallet.
 *
 * Each deposit is public, and so is the number of closes since the previous
 * one. An epoch covering one close would publish that close's fees — and fees
 * are a fixed fraction of size. So an epoch runs only when BOTH:
 *
 *   · at least EPOCH_MIN_CLOSES closes happened since the last epoch (5), and
 *   · at least EPOCH_MIN_SECONDS passed since it (1 hour).
 *
 * There is no upper limit: when trading is slow, LPs wait for their fees
 * rather than a trade's size becoming public.
 *
 * The HTTP endpoints are public (the frontend proxies them), so they show only
 * what the chain already shows. The fees received since the last epoch, or
 * the wallet's balance, would give away each trade's fee — and with it its
 * size — to anyone polling before and after it; they stay in this log.
 *
 *   GET  http://127.0.0.1:3011/health?market=BTC-USD   up, closes since the last epoch, the rules
 *   GET  http://127.0.0.1:3011/epochs?market=BTC-USD   every epoch so far: when, closes, deposit, tx
 *                                                      (ETH-USD without `market`)
 *
 * Epochs are logged in .zkperp/epochs.json, per contract.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, stackFile, walletSeed } from "../../core/network.js";
import { buildWallet, waitForSync } from "../../core/wallet.js";
import { DEFAULT_MARKET, deployedMarkets } from "../../core/markets.js";
import { readLedger, type ContractHandle } from "../../core/perp.js";
import { depositFees } from "../../core/pool.js";
import { readyWallet, treasurySeed } from "../../core/trader.js";
import { balance, coinKey, handle, waitForBalance } from "../../core/session.js";

const MIN_CLOSES = BigInt(process.env.EPOCH_MIN_CLOSES ?? 5);
const MIN_SECONDS = Number(process.env.EPOCH_MIN_SECONDS ?? 3600);
const LP_SHARE_PCT = BigInt(process.env.LP_FEE_SHARE_PCT ?? 70);
const CHECK_MS = Number(process.env.TREASURY_CHECK_MS ?? 60_000);
const PORT = Number(process.env.TREASURY_PORT ?? 3011);
const LOG_FILE = path.join(process.cwd(), ".zkperp", "epochs.json");

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fmt = (m: bigint) => `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Epoch {
  contractAddress: string;
  at: string;
  /** `closedPositions` on chain when the epoch ran. */
  closedPositions: string;
  /** Fees received since the previous epoch, pUSDC minor units. */
  fees: string;
  /** The LPs' share, deposited. */
  deposited: string;
  /** The treasury's balance after the deposit: what the next epoch counts from. */
  balanceAfter: string;
  /** Empty for a baseline. */
  txHash: string;
  /**
   * The starting point for a contract, recorded when this job first sees it.
   * The wallet outlives deployments, so its balance then may hold fees from
   * an earlier contract; those are not this pool's to pay out.
   */
  baseline?: boolean;
}

function readEpochs(): Epoch[] {
  return fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) : [];
}

function appendEpoch(epoch: Epoch): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOG_FILE, JSON.stringify([...readEpochs(), epoch], null, 2) + "\n", { mode: 0o600 });
}

/** Where the next epoch counts from: the last one, or the deployment. */
function lastEpochOn(contractAddress: string): { closed: bigint; balanceAfter: bigint; at: number } {
  const last = readEpochs()
    .filter((e) => e.contractAddress === contractAddress)
    .at(-1);
  return last
    ? { closed: BigInt(last.closedPositions), balanceAfter: BigInt(last.balanceAfter), at: Date.parse(last.at) }
    : { closed: 0n, balanceAfter: 0n, at: 0 };
}

/** One market's treasury: its wallet and its contract. */
interface MarketTreasury {
  symbol: string;
  wallet: Awaited<ReturnType<typeof readyWallet>>;
  perp: ContractHandle;
  usdc: Uint8Array;
  busy: boolean;
  lastNote: string;
}

async function main() {
  const network = activeNetwork();
  setNetworkId(network.networkId);
  const deployed = deployedMarkets(network);
  if (!deployed.length) throw new Error(`no current zkperp deployment on ${network.name}: run the setup first`);

  const devSeed = walletSeed();
  // The dev wallet is built only if a treasury still needs funding: the
  // relayer may be using it.
  const fundFromDev = async () => {
    const dev = await buildWallet({ kind: "seed", value: devSeed }, network);
    await waitForSync(dev, () => {});
    return dev;
  };
  const markets: MarketTreasury[] = [];
  for (const { market, address: perpAddress } of deployed) {
    const label = deployed.length > 1 ? `${market.symbol} treasury` : "treasury";
    log(`syncing the ${label} wallet…`);
    const seed = treasurySeed(devSeed, market.symbol);
    const wallet = await readyWallet(fundFromDev, seed, network, log, label);
    const perp: ContractHandle = await handle(wallet, seed, "zkperp", perpAddress);
    const ledger0 = await readLedger(perp);
    if (hex(ledger0.treasury.bytes) !== hex(coinKey(wallet))) {
      throw new Error(`zkperp ${market.symbol} pays its fees to a different treasury key; redeploy with the setup`);
    }
    const usdc: Uint8Array = ledger0.usdc;
    if (!readEpochs().some((e) => e.contractAddress === perpAddress)) {
      const held = await balance(wallet, usdc);
      appendEpoch({
        contractAddress: perpAddress,
        at: new Date(0).toISOString(),
        closedPositions: ledger0.closedPositions.toString(),
        fees: "0",
        deposited: "0",
        balanceAfter: held.toString(),
        txHash: "",
        baseline: true,
      });
      log(`first run on ${market.symbol}'s contract: counting fees from the current balance, ${fmt(held)}`);
    }
    markets.push({ symbol: market.symbol, wallet, perp, usdc, busy: false, lastNote: "" });
  }

  /** What an epoch now would cover, and why it may not run. */
  async function pending(m: MarketTreasury) {
    const last = lastEpochOn(m.perp.address);
    const ledger = await readLedger(m.perp);
    const held = await balance(m.wallet, m.usdc);
    const fees = held - last.balanceAfter;
    const closes = ledger.closedPositions - last.closed;
    const elapsed = Math.floor((Date.now() - last.at) / 1000);
    return { last, ledger, held, fees, closes, elapsed, toLps: (fees * LP_SHARE_PCT) / 100n };
  }

  async function runEpoch(m: MarketTreasury): Promise<string> {
    if (m.busy) return "an epoch is already running";
    m.busy = true;
    try {
      const p = await pending(m);
      if (p.closes < MIN_CLOSES) return `waiting: ${p.closes} of ${MIN_CLOSES} closes since the last epoch`;
      if (p.elapsed < MIN_SECONDS) return `waiting: ${p.elapsed}s of ${MIN_SECONDS}s since the last epoch`;
      if (p.toLps <= 0n) return "no fees to pay out";
      log(`${m.symbol} epoch: ${p.closes} closes, fees ${fmt(p.fees)}, ${LP_SHARE_PCT}% to LPs: ${fmt(p.toLps)}…`);
      const txHash = await depositFees(m.perp, m.usdc, p.toLps);
      // The change comes back a moment later; count from the settled balance.
      const after = await waitForBalance(m.wallet, m.usdc, (b) => b === p.held - p.toLps);
      appendEpoch({
        contractAddress: m.perp.address,
        at: new Date().toISOString(),
        closedPositions: p.ledger.closedPositions.toString(),
        fees: p.fees.toString(),
        deposited: p.toLps.toString(),
        balanceAfter: after.toString(),
        txHash,
      });
      log(chalk.green(`   deposited ${fmt(p.toLps)} in ${txHash}`));
      return `deposited ${fmt(p.toLps)} in ${txHash}`;
    } finally {
      m.busy = false;
    }
  }

  const server = http
    .createServer(async (req, res) => {
      const json = (status: number, body: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body, null, 2));
      try {
        const url = new URL(req.url ?? "/", "http://treasury");
        const symbol = (url.searchParams.get("market") ?? DEFAULT_MARKET).toUpperCase();
        const m = markets.find((x) => x.symbol === symbol);
        if (!m) return json(404, { error: "no such market here", markets: markets.map((x) => x.symbol) });
        if (req.method === "GET" && url.pathname === "/health") {
          const p = await pending(m);
          return json(200, {
            market: m.symbol,
            contract: m.perp.address,
            closesSinceLastEpoch: Number(p.closes),
            secondsSinceLastEpoch: p.last.at ? p.elapsed : null,
            rules: { minCloses: Number(MIN_CLOSES), minSeconds: MIN_SECONDS, lpSharePct: Number(LP_SHARE_PCT) },
          });
        }
        if (req.method === "GET" && url.pathname === "/epochs") {
          // Only what each deposit already shows on chain.
          return json(
            200,
            readEpochs()
              .filter((e) => e.contractAddress === m.perp.address && !e.baseline)
              .map(({ at, closedPositions, deposited, txHash }) => ({ at, closedPositions, deposited, txHash }))
          );
        }
        return json(404, { error: "not found" });
      } catch (error) {
        return json(500, { error: String(error instanceof Error ? error.message : error) });
      }
    })
    .listen(PORT, "127.0.0.1");
  for (const m of markets) log(`treasury for zkperp ${m.symbol} ${m.perp.address.slice(0, 12)}…`);
  log(`epochs every ≥${MIN_CLOSES} closes and ≥${MIN_SECONDS}s, ${LP_SHARE_PCT}% to LPs; http://127.0.0.1:${PORT}/health`);

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    for (const m of markets) {
      try {
        const result = await runEpoch(m);
        if (result !== m.lastNote) log(markets.length > 1 ? `${m.symbol}: ${result}` : result);
        m.lastNote = result;
      } catch (error) {
        log(chalk.red(`${m.symbol} error: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`));
      }
    }
    for (let waited = 0; waited < CHECK_MS && !stopping; waited += 500) await sleep(500);
  }
  log("stopping…");
  server.close();
  for (const m of markets) await m.wallet.facade.stop();
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
