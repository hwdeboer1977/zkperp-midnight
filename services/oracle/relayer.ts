// SPDX-License-Identifier: Apache-2.0

/**
 * One oracle signer: Chainlink → zkperp's `setPrice`, signed by two of three
 * signers, for every market deployed (core/markets.ts): ETH/USD to the
 * ETH-USD contract, BTC/USD to BTC-USD. The same key signs for each; a report
 * names its contract, so it cannot be replayed on another market.
 *
 *   npm run relayer -- --signer 1      # and --signer 2, --signer 3; needs EVM_RPC_URL
 *
 * Polls the feed and acts only when Chainlink publishes a NEW round — a 0.5%
 * move or the hourly heartbeat. Pricing in zkperp is strict: a trade proven at
 * one price fails if the price changes before it lands, so re-stamping the
 * same price would starve every trader.
 *
 * For each new round it signs the report (roundId, price, updatedAt) with its
 * own key and serves the signature to its peers. Then it waits its turn —
 * signer n waits (n − 1) × RELAYER_STAGGER_MS — and, unless the round is on
 * chain by then, fetches a peer's signature for the same report and submits
 * both. Normally signer 1 transmits; if it is down, signer 2 does, and so on.
 * A signer whose turn comes first asks the lower signers whether they are
 * transmitting that round (their /health), and waits for them if so. Should
 * two submit anyway, exactly one lands; the other fails on chain (its round
 * is no longer newer) and still pays its fee (measured on the devnet).
 *
 *   key      ORACLE_SIGNER_<n> (hex scalar), or derived from the dev seed
 *   wallet   ORACLE_<n>_SEED, or derived from the dev seed; funded from the
 *            dev wallet on first use. It only pays the fee.
 *   port     RELAYER_PORT, default 3019 + n
 *   store    ZKPERP_LEVEL_DB, default midnight-level-db-oracle-<n>: LevelDB
 *            opens in one process at a time, so each signer has its own
 *   peers    ORACLE_PEERS: the three relayers' URLs by signer, comma-separated;
 *            default http://127.0.0.1:3020,3021,3022
 *
 * Do not run it alongside `npm run demo` or `npm run race`: they set prices
 * themselves. A market set up while it runs is picked up on restart.
 *
 *   GET /health?market=BTC-USD               that market's last round, contract price
 *                                            and this signer's state; ETH-USD by default
 *   GET /signature/<roundId>?market=BTC-USD  this signer's signature on that round
 */

import "dotenv/config";
import http from "http";
import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { activeNetwork, walletSeed } from "../../core/network.js";
import { buildWallet, waitForSync } from "../../core/wallet.js";
import { readLedger, submitSignedPrice } from "../../core/perp.js";
import { handle } from "../../core/session.js";
import { oracleWalletSeed, readyWallet } from "../../core/trader.js";
import {
  oracleSecret,
  signatureFromJson,
  signatureToJson,
  signPrice,
  type PriceReport,
  type Signature,
  type SlotSignature,
} from "../../core/oracle.js";
import { latestRound, toSixDecimals } from "../../core/chainlink.js";
import { DEFAULT_MARKET, deployedMarkets } from "../../core/markets.js";

const POLL_MS = Number(process.env.RELAYER_POLL_MS ?? 15_000);
const TICK_MS = Number(process.env.RELAYER_TICK_MS ?? 3_000);
// More than one Chainlink poll plus a tick, so the signer before has seen the
// round and said it is transmitting by the time this one's turn comes.
const STAGGER_MS = Number(process.env.RELAYER_STAGGER_MS ?? 20_000);
// How long to trust a lower signer that says it is transmitting a round.
const TRANSMIT_WAIT_MS = Number(process.env.RELAYER_TRANSMIT_WAIT_MS ?? 120_000);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fmt = (p: bigint) => `$${p / 1_000_000n}.${(p % 1_000_000n).toString().padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This relayer's signer slot, 0-based, from `--signer n` (1 to 3) or ORACLE_SIGNER. */
function signerSlot(): number {
  const i = process.argv.indexOf("--signer");
  const raw = i >= 0 ? process.argv[i + 1] : process.env.ORACLE_SIGNER;
  const n = Number(raw);
  if (![1, 2, 3].includes(n)) throw new Error("say which signer this is: --signer 1, 2 or 3");
  return n - 1;
}

const sameReport = (a: PriceReport, b: PriceReport) =>
  a.round === b.round && a.price === b.price && a.updatedAt === b.updatedAt;

const reportToJson = (r: PriceReport) => ({ round: r.round.toString(), price: r.price.toString(), updatedAt: r.updatedAt.toString() });
const reportFromJson = (j: any): PriceReport => ({ round: BigInt(j.round), price: BigInt(j.price), updatedAt: BigInt(j.updatedAt) });

interface Health {
  signer: number;
  market: string;
  feed: string;
  contract: string;
  wallet: string;
  lastRound?: { roundId: string; price: string; updatedAt: number };
  contractPrice?: { roundId: string; price: string; priceTime: number; ageSeconds: number; maxAgeSeconds: number; signers: number[] };
  lastSigned?: { roundId: string; at: string };
  lastSubmission?: { roundId: string; txHash: string; with: number[]; at: string };
  /** The round this signer is submitting right now, for its peers to wait on. */
  transmitting?: { roundId: string; since: number };
  lastError?: { message: string; at: string };
  submissions: number;
}

async function main() {
  const rpcUrl = process.env.EVM_RPC_URL;
  if (!rpcUrl) throw new Error("EVM_RPC_URL is not set: add an Ethereum mainnet RPC URL to .env");
  const slot = signerSlot();
  process.env.ZKPERP_LEVEL_DB ??= `midnight-level-db-oracle-${slot + 1}`;
  const port = Number(process.env.RELAYER_PORT ?? 3020 + slot);
  const urls = (process.env.ORACLE_PEERS ?? "http://127.0.0.1:3020,http://127.0.0.1:3021,http://127.0.0.1:3022").split(",");
  if (urls.length !== 3) throw new Error("ORACLE_PEERS must list the three relayers' URLs, by signer");
  const peers = urls.map((url, s) => ({ slot: s, url: url.trim().replace(/\/$/, "") })).filter((p) => p.slot !== slot);

  const network = activeNetwork();
  setNetworkId(network.networkId);
  const deployed = deployedMarkets(network);
  if (!deployed.length) throw new Error(`no current zkperp deployment on ${network.name}: run the setup first`);

  const devSeed = walletSeed();
  const secret = oracleSecret(devSeed, slot);
  const seed = oracleWalletSeed(devSeed, slot);
  log(`signer ${slot + 1}: syncing its wallet…`);
  const fundFromDev = async () => {
    const dev = await buildWallet({ kind: "seed", value: devSeed }, network);
    await waitForSync(dev, () => {});
    return dev;
  };
  const wallet = await readyWallet(fundFromDev, seed, network, log, `signer ${slot + 1}`);

  /** One market's contract, its latest Chainlink report and this signer's signatures on it. */
  interface MarketState {
    symbol: string;
    feed: string;
    perp: Awaited<ReturnType<typeof handle>>;
    perpAddress: string;
    // This signer's signatures, by round; a few recent ones are enough.
    signed: Map<bigint, { report: PriceReport; signature: Signature; seenAt: number }>;
    health: Health;
    report?: PriceReport;
    polledAt: number;
  }
  const markets: MarketState[] = [];
  for (const { market, address: perpAddress } of deployed) {
    const perp = await handle(wallet, seed, "zkperp", perpAddress);
    const ledger0 = await readLedger(perp);
    const keys: { x: bigint; y: bigint }[] = [...ledger0.signers];
    const own = perp.module.pureCircuits.signerPublicKey(secret);
    if (keys[slot].x !== own.x || keys[slot].y !== own.y) {
      throw new Error(`this key is not signer ${slot + 1} of zkperp ${market.symbol} ${perpAddress.slice(0, 12)}…: check ORACLE_SIGNER_${slot + 1}`);
    }
    markets.push({
      symbol: market.symbol,
      feed: market.feed,
      perp,
      perpAddress,
      signed: new Map(),
      health: { signer: slot + 1, market: market.symbol, feed: market.feed, contract: perpAddress, wallet: wallet.unshieldedAddress, submissions: 0 },
      polledAt: 0,
    });
  }
  const bySymbol = (symbol: string | null) => markets.find((m) => m.symbol === (symbol ?? DEFAULT_MARKET).toUpperCase());

  const server = http
    .createServer((req, res) => {
      const json = (code: number, body: unknown) =>
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body, null, 2));
      const url = new URL(req.url ?? "/", "http://relayer");
      const ms = bySymbol(url.searchParams.get("market"));
      if (!ms) return json(404, { error: "no such market here", markets: markets.map((m) => m.symbol) });
      if (url.pathname === "/health") return json(200, { ...ms.health, markets: markets.map((m) => m.symbol) });
      const m = url.pathname.match(/^\/signature\/(\d+)$/);
      const mine = m ? ms.signed.get(BigInt(m[1])) : undefined;
      if (!mine) return json(404, { error: "no signature for that round" });
      json(200, { slot, report: reportToJson(mine.report), signature: signatureToJson(mine.signature) });
    })
    .listen(port, "127.0.0.1");
  for (const m of markets) log(`signer ${slot + 1} relaying ${m.symbol} (${m.feed}) to zkperp ${m.perpAddress.slice(0, 12)}…`);
  log(`signer ${slot + 1} on http://127.0.0.1:${port}`);

  /** Peers' signatures on exactly `report`; a peer that is down or signed another report is skipped. */
  const peerSignatures = async (symbol: string, report: PriceReport): Promise<SlotSignature[]> => {
    const found = await Promise.all(
      peers.map(async (p): Promise<SlotSignature | null> => {
        try {
          const r = await fetch(`${p.url}/signature/${report.round}?market=${symbol}`, { signal: AbortSignal.timeout(2_000) });
          if (!r.ok) return null;
          const body: any = await r.json();
          if (body.slot !== p.slot || !sameReport(reportFromJson(body.report), report)) return null;
          return { slot: p.slot, signature: signatureFromJson(body.signature) };
        } catch {
          return null;
        }
      })
    );
    return found.filter((x): x is SlotSignature => x !== null);
  };

  /** A lower signer that says it is submitting `round` now, if any. */
  const lowerTransmitting = async (symbol: string, round: bigint): Promise<number | undefined> => {
    for (const p of peers.filter((x) => x.slot < slot)) {
      try {
        const r = await fetch(`${p.url}/health?market=${symbol}`, { signal: AbortSignal.timeout(2_000) });
        const t = r.ok ? ((await r.json()) as any).transmitting : undefined;
        if (t && BigInt(t.roundId) === round && Date.now() - t.since < TRANSMIT_WAIT_MS) return p.slot;
      } catch {
        // Down: not transmitting.
      }
    }
    return undefined;
  };

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let noted = "";
  const note = (key: string, line: string) => {
    if (noted !== key) log(line);
    noted = key;
  };
  /** One pass over one market: poll its feed, sign a new round, transmit it in turn. */
  const tick = async (ms: MarketState) => {
    const { symbol, perp, perpAddress, signed, health } = ms;
    const pc = perp.module.pureCircuits;
    const tag = markets.length > 1 ? `${symbol} ` : "";
    try {
      if (Date.now() - ms.polledAt >= POLL_MS) {
        const round = await latestRound(rpcUrl, ms.feed);
        ms.polledAt = Date.now();
        ms.report = { round: round.roundId, price: toSixDecimals(round.answer, round.decimals), updatedAt: round.updatedAt };
        health.lastRound = { roundId: round.roundId.toString(), price: fmt(ms.report.price), updatedAt: Number(round.updatedAt) };
      }
      const report = ms.report;
      const ledger = await readLedger(perp);
      const now = Math.floor(Date.now() / 1000);
      health.contractPrice = {
        roundId: ledger.priceRound.toString(),
        price: fmt(ledger.markPrice),
        priceTime: Number(ledger.priceTime),
        ageSeconds: now - Number(ledger.priceTime),
        maxAgeSeconds: Number(ledger.maxPriceAge),
        signers: [...ledger.priceSigners].map((s: bigint) => Number(s) + 1),
      };

      if (!report || report.round <= ledger.priceRound) {
        // On chain already, or the contract is ahead of this round (a mock
        // price from `npm run price`): wait for a newer round.
      } else if (report.updatedAt < ledger.priceTime) {
        note(`older:${symbol}:${report.round}`, `${tag}round ${report.round} (${fmt(report.price)}) is older than the contract's price; waiting for a newer round`);
      } else {
        let mine = signed.get(report.round);
        if (!mine) {
          mine = { report, signature: signPrice(pc, perpAddress, report, secret), seenAt: Date.now() };
          signed.set(report.round, mine);
          for (const r of [...signed.keys()].sort((a, b) => (a < b ? -1 : 1)).slice(0, -8)) signed.delete(r);
          health.lastSigned = { roundId: report.round.toString(), at: new Date().toISOString() };
          log(`${tag}new round ${report.round}: ${fmt(report.price)}, published ${now - Number(report.updatedAt)}s ago — signed`);
        }
        if (Date.now() - mine.seenAt >= slot * STAGGER_MS) {
          const theirs = await peerSignatures(symbol, report);
          const busy = await lowerTransmitting(symbol, report.round);
          if (busy !== undefined) {
            note(`busy:${symbol}:${report.round}`, `   ${tag}signer ${busy + 1} is transmitting round ${report.round}; waiting`);
          } else if (theirs.length === 0) {
            note(`peers:${symbol}:${report.round}`, `   ${tag}no peer has signed round ${report.round} yet; waiting`);
          } else {
            const sigs = [{ slot, signature: mine.signature }, ...theirs];
            const used = sigs.map((s) => s.slot).sort().slice(0, 2);
            log(`   ${tag}transmitting round ${report.round} with signers ${used.map((s) => s + 1).join(" and ")}…`);
            health.transmitting = { roundId: report.round.toString(), since: Date.now() };
            const txHash = await submitSignedPrice(perp, report, sigs).finally(() => {
              health.transmitting = undefined;
            });
            health.submissions += 1;
            health.lastSubmission = { roundId: report.round.toString(), txHash, with: used.map((s) => s + 1), at: new Date().toISOString() };
            log(chalk.green(`   ${tag}set ${fmt(report.price)} in ${txHash}`));
          }
        }
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      health.lastError = { message, at: new Date().toISOString() };
      const report = ms.report;
      // Another signer's transmission of the same round landed first. Refused
      // locally, nothing is lost; refused on chain (FailFallible), the fee is.
      if (/round is not newer/.test(message)) log(chalk.gray(`   ${tag}another signer transmitted this round first`));
      else if (/FailFallible/.test(message) && report && (await readLedger(perp).catch(() => null))?.priceRound >= report.round) {
        log(chalk.yellow(`   ${tag}another signer's transmission of this round landed first; this one failed on chain and paid its fee`));
      } else log(chalk.red(`${tag}error: ${message}`));
    }
  };
  while (!stopping) {
    for (const ms of markets) if (!stopping) await tick(ms);
    for (let waited = 0; waited < TICK_MS && !stopping; waited += 500) await sleep(500);
  }

  log("stopping…");
  server.close();
  await wallet.facade.stop();
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
