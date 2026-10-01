// SPDX-License-Identifier: Apache-2.0

/**
 * The position lifecycle on the local devnet, with two wallets.
 *
 *   npm run devnet:up && npm run compile && npm run demo
 *
 *   dev wallet     deploys pUSDC and zkperp, provides liquidity, runs the oracle
 *   trader wallet  a separate seed, funded from the dev wallet on first use
 *
 * CUSTODY — does collateral come back out?
 *   The contract never records a position's collateral coin; only the trader
 *   knows its nonce. This opens a long and closes it at an unchanged price,
 *   and requires the trader's pUSDC balance to return to exactly where it was.
 *
 * SOLVENCY — every open reserves the constant `maxPayout` and every close
 *   releases it; a profit beyond the cap is paid exactly the cap.
 *
 * PNL — does the pool settle both ways?
 *   Opens, moves the price up 10%, closes: the trader gains exactly the
 *   profit and the pool loses exactly that. Then the same with the price down
 *   5%: the trader loses exactly the loss and the pool gains it.
 *
 * LIQUIDITY — can LPs get out, and only what is not reserved?
 *   Redeems a tenth of the dev wallet's zLP; is refused emptying the pool
 *   while a position is open; then empties it once nothing is open. The next
 *   run deposits afresh.
 *
 * Every trade transaction is fetched raw from the indexer and searched for the
 * position's size, collateral, secrets and the trader's key, with the search
 * whose coverage `npm run probe:leak` verifies.
 */

import chalk from "chalk";
import * as Rx from "rxjs";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { createHash, randomBytes } from "crypto";
import { LOCAL, walletSeed } from "./network.js";
import { buildWallet, makeWalletProviders, waitForSync, type BuiltWallet } from "./wallet.js";
import { makeProviders } from "./providers.js";
import { getDeployment, loadCompiledContract, saveDeployment, type ContractName } from "./contracts.js";
import { readyTrader, traderSeed } from "./trader.js";
import { closeLong, longPnl, openLong, readLedger, type ContractHandle } from "./perp.js";
import { positionsFile, reconcile } from "./positions.js";
import { redeemable, removeLiquidity } from "./pool.js";
import { findBytes, findNumber, rawTransaction } from "./leak-search.js";

const PUSDC = 1_000_000n;
const DEV_MINT = 1_000_000n * PUSDC;
const LIQUIDITY = 500_000n * PUSDC;
const TRADER_MINT = 10_000n * PUSDC;
const PRICE = 3_000_000_000n; // $3,000.000000
const MAX_LEVERAGE = 50n;
const MIN_COLLATERAL = 10n * PUSDC;
// The most any position can win, and so what each open reserves. Small enough
// that a 50% move at 10x hits it, so the demo can show the cap binding.
const MAX_PAYOUT = 5_000n * PUSDC;

// Distinctive, so a match in raw bytes means a leak and not a coincidence.
const COLLATERAL = 1_234_567_891n; // 1,234.567891 pUSDC
const SIZE = 12_345_678_912n; //    ~10x

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fmt = (minor: bigint) => {
  const sign = minor < 0n ? "-" : "";
  const m = minor < 0n ? -minor : minor;
  return `${sign}${(m / PUSDC).toLocaleString("en-US")}.${(m % PUSDC).toString().padStart(6, "0")}`;
};
const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));

const results: Array<{ section: string; name: string; ok: boolean }> = [];
let section = "";
function check(name: string, ok: boolean) {
  results.push({ section, name, ok });
  console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}`);
}

interface Party {
  wallet: BuiltWallet;
  seed: string;
  coinPublicKey: Uint8Array;
  pusdc: ContractHandle;
  perp: ContractHandle;
}

async function main() {
  const network = LOCAL;
  setNetworkId(network.networkId);
  const devSeed = walletSeed();
  const adminSecret = createHash("sha256").update(`zkperp-admin:${devSeed}`).digest();

  step("Wallets");
  const devWallet = await buildWallet({ kind: "seed", value: devSeed }, network);
  let traderWallet: BuiltWallet | null = null;
  try {
    await waitForSync(devWallet, () => {});
    info(`dev    ${devWallet.unshieldedAddress}`);
    traderWallet = await readyTrader(devWallet, traderSeed(devSeed), network, info);
    info(`trader ${traderWallet.unshieldedAddress}`);

    // ── Contracts, deployed by the dev wallet ─────────────────────────────
    step("Contracts");
    const pusdcAddress = await deployOrFind(devWallet, devSeed, "pusdc", async () => []);
    const devPusdc = await handle(devWallet, devSeed, "pusdc", pusdcAddress);
    // Before the first mint pUSDC has no token type yet, so the balance check
    // needs one mint to exist; after that, top up whenever a new pool needs it.
    if ((await readLedger(devPusdc)).totalSupply === 0n) {
      info(`dev mints ${fmt(DEV_MINT)} pUSDC for liquidity…`);
      await devPusdc.deployed.callTx.mint(DEV_MINT);
    }
    const usdc: Uint8Array = (await readLedger(devPusdc)).tokenId;
    if ((await balance(devWallet, usdc)) < LIQUIDITY) {
      info(`dev mints ${fmt(DEV_MINT)} pUSDC for liquidity…`);
      await devPusdc.deployed.callTx.mint(DEV_MINT);
    }
    info(`pUSDC  ${pusdcAddress}`);

    const perpAddress = await deployOrFind(devWallet, devSeed, "zkperp", async (module) => [
      usdc,
      module.pureCircuits.adminKey(adminSecret),
      PRICE,
      MAX_LEVERAGE,
      MIN_COLLATERAL,
      MAX_PAYOUT,
    ]);
    const devPerp = await handle(devWallet, devSeed, "zkperp", perpAddress);
    info(`zkperp ${perpAddress}`);
    if (hex((await readLedger(devPerp)).usdc) !== hex(usdc)) {
      throw new Error("deployment.json pairs this zkperp with a different pUSDC — run npm run devnet:reset");
    }

    if ((await readLedger(devPerp)).poolValue === 0n) {
      await waitForBalance(devWallet, usdc, (b) => b >= LIQUIDITY);
      info(`dev adds ${fmt(LIQUIDITY)} pUSDC of liquidity…`);
      await devPerp.deployed.callTx.addLiquidity({ nonce: randomBytes(32), color: usdc, value: LIQUIDITY }, LIQUIDITY);
    }
    await setPrice(devPerp, PRICE, adminSecret);

    const dev: Party = {
      wallet: devWallet,
      seed: devSeed,
      coinPublicKey: coinKey(devWallet),
      pusdc: devPusdc,
      perp: devPerp,
    };
    const traderSeedHex = traderSeed(devSeed);
    const trader: Party = {
      wallet: traderWallet,
      seed: traderSeedHex,
      coinPublicKey: coinKey(traderWallet),
      pusdc: await handle(traderWallet, traderSeedHex, "pusdc", pusdcAddress),
      perp: await handle(traderWallet, traderSeedHex, "zkperp", perpAddress),
    };

    const tree = (await readLedger(devPerp)).positions;
    const settled = reconcile(perpAddress, (c) => tree.findPathForLeaf(Uint8Array.from(Buffer.from(c, "hex"))) !== undefined);
    if (settled.opened || settled.failed) {
      info(`reconciled earlier pending positions: ${settled.opened} open, ${settled.failed} failed`);
    }

    if ((await balance(trader.wallet, usdc)) < 3n * COLLATERAL) {
      info(`trader mints ${fmt(TRADER_MINT)} pUSDC…`);
      await trader.pusdc.deployed.callTx.mint(TRADER_MINT);
    }
    await waitForBalance(trader.wallet, usdc, (b) => b >= 3n * COLLATERAL);
    info(`trader holds ${fmt(await balance(trader.wallet, usdc))} pUSDC, shielded`);
    info(`pool ${fmt((await readLedger(devPerp)).poolValue)} pUSDC at $${fmt(PRICE)}`);

    // ── Step 3: custody ───────────────────────────────────────────────────
    section = "custody";
    step("Custody — open and close at an unchanged price");
    {
      const before = await balance(trader.wallet, usdc);
      const poolBefore = (await readLedger(devPerp)).poolValue;
      const devBefore = await balance(dev.wallet, usdc);

      const reservedBefore = (await readLedger(devPerp)).reserved;
      const opened = await openLong(trader.perp, usdc, COLLATERAL, SIZE, network.networkId);
      info(`opened ${opened.txHash}`);
      check(
        "the open reserved exactly maxPayout — the same for every position",
        (await readLedger(devPerp)).reserved === reservedBefore + MAX_PAYOUT
      );
      const whileOpen = await waitForBalance(trader.wallet, usdc, (b) => b < before);
      check(`the trader paid exactly the collateral (${fmt(before)} → ${fmt(whileOpen)})`, before - whileOpen === COLLATERAL);
      await privacy("open", opened.txHash, trader, opened.record, perpAddress, usdc);

      const closed = await closeLong(trader.perp, opened.record, usdc, trader.coinPublicKey);
      info(`closed ${closed.txHash}`);
      const afterClose = await waitForBalance(trader.wallet, usdc, (b) => b > whileOpen);
      check(`the collateral came back in full (${fmt(whileOpen)} → ${fmt(afterClose)})`, afterClose === before);
      check("the pool did not move", (await readLedger(devPerp)).poolValue === poolBefore);
      check("the dev wallet did not receive it", (await balance(dev.wallet, usdc)) === devBefore);
      check("the close released the reservation", (await readLedger(devPerp)).reserved === reservedBefore);
      await privacy("close", closed.txHash, trader, opened.record, perpAddress, usdc, closed.nullifier);
    }

    // ── Step 4: PnL against the pool ──────────────────────────────────────
    for (const [label, exit] of [
      ["profit — price up 10%", 3_300_000_000n],
      ["loss — price down 5%", 2_850_000_000n],
      // Each of these exercises a branch combination that only the real
      // circuit can check: the JS runtime skips untaken branches, the proof
      // does not (see the note in closeLong).
      ["profit above the collateral — price up 25%", 3_750_000_000n],
      ["wipe-out — price down 20%", 2_400_000_000n],
      // Raw profit ≈ 6,173 pUSDC; the cap pays 5,000 — an enforced take-profit.
      ["payout cap — price up 50%", 4_500_000_000n],
    ] as const) {
      section = label;
      step(`PnL, ${label}`);
      await setPrice(devPerp, PRICE, adminSecret);
      const before = await balance(trader.wallet, usdc);
      const opened = await openLong(trader.perp, usdc, COLLATERAL, SIZE, network.networkId);
      info(`opened at $${fmt(PRICE)}: ${opened.txHash}`);
      const whileOpen = await waitForBalance(trader.wallet, usdc, (b) => b < before);

      await setPrice(devPerp, exit, adminSecret);
      const poolBefore = (await readLedger(devPerp)).poolValue;
      const closed = await closeLong(trader.perp, opened.record, usdc, trader.coinPublicKey);
      const expected = longPnl(SIZE, PRICE, exit, MAX_PAYOUT);
      info(`closed at $${fmt(exit)}: ${closed.txHash}`);
      info(`${closed.profit ? "profit" : "loss"} ${fmt(closed.pnl)} pUSDC${closed.capped ? " (capped at maxPayout)" : ""}`);
      check(
        closed.capped
          ? "the profit is exactly maxPayout, not the larger raw PnL"
          : "the PnL is size × Δprice / entry, rounded for the pool",
        closed.pnl === expected.pnl && closed.profit === expected.profit && closed.capped === expected.capped
      );
      if (label.startsWith("payout cap")) check("the cap bound, as intended", closed.capped);

      // A loss beyond the collateral costs only the collateral.
      const signed = closed.profit ? closed.pnl : -(closed.pnl < COLLATERAL ? closed.pnl : COLLATERAL);
      const afterClose =
        signed === -COLLATERAL
          ? await balance(trader.wallet, usdc) // nothing comes back to wait for
          : await waitForBalance(trader.wallet, usdc, (b) => b > whileOpen);
      check(
        `the trader ends at start ${signed >= 0n ? "+" : "−"} ${fmt(signed < 0n ? -signed : signed)} (${fmt(before)} → ${fmt(afterClose)})`,
        afterClose === before + signed
      );
      const poolAfter = (await readLedger(devPerp)).poolValue;
      check(
        `the pool moves by the opposite amount (${fmt(poolBefore)} → ${fmt(poolAfter)})`,
        poolAfter === poolBefore - signed
      );
      check("no reservation is left behind", (await readLedger(devPerp)).reserved === 0n);
      await privacy("close", closed.txHash, trader, opened.record, perpAddress, usdc, closed.nullifier);
    }
    await setPrice(devPerp, PRICE, adminSecret);

    // ── Step 5: LP withdrawal ─────────────────────────────────────────────
    section = "liquidity";
    step("Liquidity — withdraw only what is not reserved");
    {
      const l = await readLedger(devPerp);
      const lpToken: Uint8Array = l.lpToken;
      const shares = await balance(dev.wallet, lpToken);
      check(`the dev wallet holds every zLP share (${fmt(shares)})`, shares === l.lpSupply);

      const part = shares / 10n;
      const devBefore = await balance(dev.wallet, usdc);
      const expected = redeemable(l, part);
      const out = await removeLiquidity(devPerp, part);
      info(`redeemed ${fmt(part)} zLP for ${fmt(out.amount)} pUSDC: ${out.txHash}`);
      const devAfter = await waitForBalance(dev.wallet, usdc, (b) => b > devBefore);
      check("the LP is paid shares × poolValue / lpSupply, rounded down", out.amount === expected && devAfter - devBefore === expected);
      const l2 = await readLedger(devPerp);
      check("the pool shrinks by exactly that", l2.poolValue === l.poolValue - expected);
      check("the redeemed shares are retired", l2.lpSupply === l.lpSupply - part);
      check("the LP's zLP balance drops by them", (await waitForBalance(dev.wallet, lpToken, (b) => b < shares)) === shares - part);

      // An open position reserves maxPayout: the pool cannot be emptied.
      const opened = await openLong(trader.perp, usdc, COLLATERAL, SIZE, network.networkId);
      info(`opened ${opened.txHash}`);
      let refusal = "";
      try {
        await removeLiquidity(devPerp, l2.lpSupply);
      } catch (error) {
        refusal = String(error instanceof Error ? error.message : error);
      }
      check("emptying the pool is refused while a position is open", /reserved for open positions/.test(refusal));
      await closeLong(trader.perp, opened.record, usdc, trader.coinPublicKey);
      info("closed it at an unchanged price");

      // Nothing open: the last LP may take everything.
      const l3 = await readLedger(devPerp);
      const devBeforeAll = await balance(dev.wallet, usdc);
      const all = await removeLiquidity(devPerp, l3.lpSupply);
      info(`redeemed the remaining ${fmt(l3.lpSupply)} zLP for ${fmt(all.amount)} pUSDC: ${all.txHash}`);
      const devAfterAll = await waitForBalance(dev.wallet, usdc, (b) => b > devBeforeAll);
      check("the last LP receives the whole pool", all.amount === l3.poolValue && devAfterAll - devBeforeAll === l3.poolValue);
      const l4 = await readLedger(devPerp);
      check("the pool is empty and has no shares left", l4.poolValue === 0n && l4.lpSupply === 0n);
    }

    // ── Summary ───────────────────────────────────────────────────────────
    const l = await readLedger(devPerp);
    console.log();
    info(`positions opened ${l.openPositions}, closed ${l.closedPositions}; pool ${fmt(l.poolValue)} pUSDC, reserved ${fmt(l.reserved)}`);
    info(`trader's openings: ${positionsFile()}`);
    const failed = results.filter((r) => !r.ok);
    console.log();
    if (failed.length) {
      console.log(chalk.red.bold(`${failed.length} of ${results.length} checks failed`));
      process.exitCode = 1;
    } else {
      console.log(chalk.green.bold(`All ${results.length} checks passed.`));
    }
  } finally {
    await traderWallet?.facade.stop();
    await devWallet.facade.stop();
  }
}

/**
 * Searches one trade's raw transaction for what must stay private. Controls
 * first: the contract address, and for a close its nullifier — 32 bytes the
 * circuit publishes on purpose. Numbers are covered by `probe:leak`.
 */
async function privacy(
  kind: "open" | "close",
  txHash: string,
  trader: Party,
  record: { commitment: string; opening: Record<string, any> },
  contractAddress: string,
  usdc: Uint8Array,
  nullifier?: Uint8Array
) {
  const raw = await rawTransaction(LOCAL.indexer, txHash);
  const o = record.opening;
  info(`${kind}: searching ${raw.length / 2} bytes of raw transaction`);
  check(`${kind} control: the contract address is found`, findBytes(raw, contractAddress));
  if (nullifier) check(`${kind} control: the nullifier is found`, findBytes(raw, nullifier));

  const absent = (label: string, found: boolean | string[]) =>
    check(
      `${kind}: ${label} is not in the transaction`,
      Array.isArray(found) ? found.length === 0 : !found
    );
  absent("size", findNumber(raw, BigInt(o.size)));
  absent("collateral", findNumber(raw, BigInt(o.collateral)));
  absent("owner secret", findBytes(raw, o.ownerSecret));
  absent("salt", findBytes(raw, o.salt));
  absent("collateral coin nonce", findBytes(raw, o.collateralNonce));
  absent("position commitment", findBytes(raw, record.commitment));
  absent("trader's coin public key", findBytes(raw, trader.coinPublicKey));
  void usdc;
}

async function deployOrFind(
  wallet: BuiltWallet,
  seed: string,
  name: ContractName,
  args: (module: any) => Promise<unknown[]>
): Promise<string> {
  const known = getDeployment(LOCAL.networkId, name);
  const providers = providersFor(wallet, seed, name);
  if (known && (await providers.publicDataProvider.queryContractState(known))) return known;
  const { module, compiledContract } = await loadCompiledContract(name);
  info(`deploying ${name}…`);
  const deployed: any = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    args: await args(module),
  } as any);
  const address: string = deployed.deployTxData.public.contractAddress;
  saveDeployment(LOCAL.networkId, name, address);
  return address;
}

function providersFor(wallet: BuiltWallet, seed: string, name: ContractName) {
  const { walletProvider, midnightProvider } = makeWalletProviders(wallet);
  return makeProviders({
    contractName: name,
    network: LOCAL,
    seedHex: seed,
    accountId: wallet.unshieldedAddress,
    walletProvider,
    midnightProvider,
  });
}

async function handle(wallet: BuiltWallet, seed: string, name: ContractName, address: string): Promise<ContractHandle> {
  const providers = providersFor(wallet, seed, name);
  const { module, compiledContract } = await loadCompiledContract(name);
  const deployed: any = await findDeployedContract(providers as any, {
    contractAddress: address,
    compiledContract: compiledContract as any,
  } as any);
  return { address, deployed, providers, module };
}

async function setPrice(perp: ContractHandle, price: bigint, adminSecret: Uint8Array) {
  if ((await readLedger(perp)).markPrice === price) return;
  info(`oracle: price → $${fmt(price)}`);
  await perp.deployed.callTx.setPrice(price, adminSecret);
}

function coinKey(wallet: BuiltWallet): Uint8Array {
  return Uint8Array.from(Buffer.from(String(wallet.shieldedSecretKeys.coinPublicKey), "hex"));
}

function shieldedBalance(state: any, usdc: Uint8Array): bigint {
  const balances = (state.shielded as any).balances as Record<string, bigint>;
  return balances[hex(usdc)] ?? balances[`0x${hex(usdc)}`] ?? 0n;
}

async function balance(wallet: BuiltWallet, usdc: Uint8Array): Promise<bigint> {
  return shieldedBalance(await Rx.firstValueFrom(wallet.facade.state()), usdc);
}

/** Wallets see a transaction's coins a moment after it lands. */
function waitForBalance(wallet: BuiltWallet, usdc: Uint8Array, ok: (b: bigint) => boolean): Promise<bigint> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.map((s) => shieldedBalance(s, usdc)),
      Rx.filter(ok),
      Rx.timeout(180_000)
    )
  );
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
