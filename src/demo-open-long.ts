// SPDX-License-Identifier: Apache-2.0

/**
 * End to end on the local devnet: pUSDC → pool → a private 10x long.
 *
 *   npm run devnet:up && npm run compile && npm run demo:open-long
 *
 * 1. Deploys pUSDC and mints the wallet 1,000,000 pUSDC.
 * 2. Deploys zkperp against that token, with a mock oracle at $3,000.
 * 3. Adds 500,000 pUSDC of liquidity and receives zLP.
 * 4. Opens a ~10x long with 1,234.567891 pUSDC collateral.
 * 5. Checks the result on chain: the commitment is in the tree, the pool did
 *    not move, and the raw transaction and contract state contain neither the
 *    size, the collateral nor any of the position's secrets.
 *
 * Re-runnable: contracts already in deployment.json and still on chain are
 * reused, and liquidity is only added to an empty pool. `npm run devnet:reset`
 * starts from a fresh chain.
 *
 * One wallet plays every role here — deployer, LP, oracle admin and trader.
 * The privacy check is about what the chain shows, which does not depend on
 * that; a separate trader wallet is the obvious next step.
 */

import { randomBytes, createHash } from "crypto";
import chalk from "chalk";
import * as Rx from "rxjs";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, walletSeed } from "./network.js";
import { buildWallet, makeWalletProviders, waitForSync, type BuiltWallet } from "./wallet.js";
import { makeProviders } from "./providers.js";
import { getDeployment, loadCompiledContract, saveDeployment, type ContractName } from "./contracts.js";
import { confirmOpen, positionsFile, recordPending } from "./positions.js";

const PUSDC = 1_000_000n; // minor units per pUSDC
const MINT = 1_000_000n * PUSDC;
const LIQUIDITY = 500_000n * PUSDC;
const INITIAL_PRICE = 3_000_000_000n; // $3,000, 6 decimals
const MAX_LEVERAGE = 50n;
const MIN_COLLATERAL = 10n * PUSDC;
// Distinctive rather than round, so a match in the raw transaction bytes means
// a leak and not a coincidence.
const COLLATERAL = 1_234_567_891n; // 1,234.567891 pUSDC
const SIZE = 12_345_678_912n; //    12,345.678912 pUSDC notional, ~10x

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fmt = (minor: bigint) =>
  `${(minor / PUSDC).toLocaleString("en-US")}.${(minor % PUSDC).toString().padStart(6, "0")}`;
const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));

async function main() {
  const network = LOCAL;
  setNetworkId(network.networkId);
  const seed = walletSeed();
  // The oracle admin's secret, derived from the wallet so reruns agree on it.
  const adminSecret = createHash("sha256").update(`zkperp-admin:${seed}`).digest();

  step("Wallet");
  const wallet = await buildWallet({ kind: "seed", value: seed }, network);
  try {
    const state = await waitForSync(wallet, info);
    const dust = state.dust.balance(new Date());
    info(`address ${wallet.unshieldedAddress}`);
    info(`tDUST   ${dust}`);
    if (dust === 0n) throw new Error("No tDUST for fees. On a fresh devnet, wait ~30s and retry.");

    const { walletProvider, midnightProvider } = makeWalletProviders(wallet);
    const providersFor = (contractName: ContractName) =>
      makeProviders({
        contractName,
        network,
        seedHex: seed,
        accountId: wallet.unshieldedAddress,
        walletProvider,
        midnightProvider,
      });

    // ── 1. pUSDC ──────────────────────────────────────────────────────────
    step("pUSDC");
    const pusdc = await deployOrFind("pusdc", providersFor("pusdc"), []);
    let usdcLedger = await readLedger(pusdc);
    if (usdcLedger.totalSupply === 0n) {
      info(`minting ${fmt(MINT)} pUSDC to this wallet…`);
      const tx = await pusdc.deployed.callTx.mint(MINT);
      info(`tx ${tx.public.txHash}`);
      usdcLedger = await readLedger(pusdc);
    }
    const usdc: Uint8Array = usdcLedger.tokenId;
    info(`token type ${hex(usdc)}`);
    info(`total supply ${fmt(usdcLedger.totalSupply)} pUSDC (public — individual balances are not)`);
    const held = await waitForBalance(wallet, hex(usdc), COLLATERAL);
    info(`this wallet holds ${fmt(held)} pUSDC, shielded`);

    // ── 2. zkperp ─────────────────────────────────────────────────────────
    step("zkperp");
    const { module: perpModule } = await loadCompiledContract("zkperp");
    const perp = await deployOrFind("zkperp", providersFor("zkperp"), [
      usdc,
      perpModule.pureCircuits.adminKey(adminSecret),
      INITIAL_PRICE,
      MAX_LEVERAGE,
      MIN_COLLATERAL,
    ]);
    let perpLedger = await readLedger(perp);
    if (hex(perpLedger.usdc) !== hex(usdc)) {
      throw new Error(
        "The zkperp in deployment.json takes a different token than this pUSDC. " +
          "Remove its entry from deployment.json to redeploy."
      );
    }
    info(`mark price $${fmt(perpLedger.markPrice)}, max leverage ${perpLedger.maxLeverage}x`);

    // ── 3. Liquidity ──────────────────────────────────────────────────────
    step("Liquidity");
    if (perpLedger.poolValue === 0n) {
      await waitForBalance(wallet, hex(usdc), LIQUIDITY);
      info(`depositing ${fmt(LIQUIDITY)} pUSDC…`);
      const tx = await perp.deployed.callTx.addLiquidity(
        { nonce: randomBytes(32), color: usdc, value: LIQUIDITY },
        LIQUIDITY // first deposit: one share per unit
      );
      info(`tx ${tx.public.txHash}`);
      perpLedger = await readLedger(perp);
    } else {
      info("pool already funded — reusing it");
    }
    info(`pool ${fmt(perpLedger.poolValue)} pUSDC, ${fmt(perpLedger.lpSupply)} zLP issued`);

    // ── 4. Open a long ────────────────────────────────────────────────────
    step("Open a long");
    const balanceBefore = await waitForBalance(wallet, hex(usdc), COLLATERAL);
    const ownerSecret = new Uint8Array(randomBytes(32));
    const opening = {
      owner: perpModule.pureCircuits.ownerKey(ownerSecret) as Uint8Array,
      isLong: true,
      size: SIZE,
      collateral: COLLATERAL,
      entryPrice: perpLedger.markPrice,
      collateralNonce: new Uint8Array(randomBytes(32)),
      salt: new Uint8Array(randomBytes(32)),
    };
    const commitment: Uint8Array = perpModule.pureCircuits.positionCommitment(opening);

    info(`collateral ${fmt(COLLATERAL)} pUSDC, size ${fmt(SIZE)} (${Number((SIZE * 100n) / COLLATERAL) / 100}x), entry $${fmt(opening.entryPrice)}`);
    recordPending({
      contractAddress: perp.address,
      networkId: network.networkId,
      commitment: hex(commitment),
      opening: {
        ownerSecret: hex(ownerSecret),
        isLong: true,
        size: SIZE.toString(),
        collateral: COLLATERAL.toString(),
        entryPrice: opening.entryPrice.toString(),
        collateralNonce: hex(opening.collateralNonce),
        salt: hex(opening.salt),
      },
    });
    info(`opening saved to ${positionsFile()} before submitting`);

    info("proving and submitting…");
    const openTx = await perp.deployed.callTx.openLong(
      { nonce: opening.collateralNonce, color: usdc, value: COLLATERAL },
      SIZE,
      ownerSecret,
      opening.salt
    );
    const txHash: string = openTx.public.txHash;
    confirmOpen(hex(commitment), txHash);
    info(`tx ${txHash}`);

    // ── 5. Check what the chain shows ─────────────────────────────────────
    step("On chain");
    const poolBefore = perpLedger.poolValue;
    perpLedger = await readLedger(perp);
    const checks: Array<[string, boolean]> = [];
    checks.push(["the commitment is in the positions tree", perpLedger.positions.findPathForLeaf(commitment) !== undefined]);
    checks.push(["the pool did not move", perpLedger.poolValue === poolBefore]);
    const balanceAfter = await waitForBalanceBelow(wallet, hex(usdc), balanceBefore);
    checks.push([
      `the wallet paid exactly the collateral (${fmt(balanceBefore)} → ${fmt(balanceAfter)})`,
      balanceBefore - balanceAfter === COLLATERAL,
    ]);

    const raw = await rawTransaction(network.indexer, txHash);
    const contractState = await perp.providers.publicDataProvider.queryContractState(perp.address);
    const haystack = `${raw}\n${contractState?.data.toString() ?? ""}`.toLowerCase();
    info(`searched ${raw.length / 2} bytes of raw transaction and the full contract state`);

    // Positive control: a search that finds nothing proves nothing unless it
    // can find what IS there.
    checks.push(["control: the contract address is found in the raw tx", haystack.includes(perp.address.toLowerCase())]);
    checks.push(["control: pUSDC's token type is found in the raw tx", haystack.includes(hex(usdc))]);
    checks.push(["size is not on chain", !encodings(SIZE).some((e) => haystack.includes(e))]);
    checks.push(["collateral is not on chain", !encodings(COLLATERAL).some((e) => haystack.includes(e))]);
    checks.push(["owner secret is not on chain", !haystack.includes(hex(ownerSecret))]);
    checks.push(["owner key is not on chain", !haystack.includes(hex(opening.owner))]);
    checks.push(["salt is not on chain", !haystack.includes(hex(opening.salt))]);
    checks.push(["collateral coin nonce is not on chain", !haystack.includes(hex(opening.collateralNonce))]);
    checks.push(["the commitment itself is not on chain (the tree stores its hash)", !haystack.includes(hex(commitment))]);

    console.log();
    for (const [name, ok] of checks) console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}`);
    info(`positions opened on this contract: ${perpLedger.openPositions}`);

    const failed = checks.filter(([, ok]) => !ok).length;
    console.log();
    if (failed) {
      console.log(chalk.red.bold(`${failed} check(s) failed`));
      process.exitCode = 1;
    } else {
      console.log(chalk.green.bold("Long opened privately. All checks passed."));
    }
  } finally {
    await wallet.facade.stop();
  }
}

/** Reuses the contract in deployment.json if it is still on chain; otherwise deploys. */
async function deployOrFind(name: ContractName, providers: any, args: unknown[]) {
  const { module, compiledContract } = await loadCompiledContract(name);
  const known = getDeployment(LOCAL.networkId, name);
  if (known && (await providers.publicDataProvider.queryContractState(known))) {
    info(`reusing ${name} at ${known}`);
    const deployed: any = await findDeployedContract(providers, {
      contractAddress: known,
      compiledContract: compiledContract as any,
    } as any);
    return { name, address: known, deployed, providers, module };
  }
  info(`deploying ${name}…`);
  const deployed: any = await deployContract(providers, {
    compiledContract: compiledContract as any,
    args,
  } as any);
  const address: string = deployed.deployTxData.public.contractAddress;
  saveDeployment(LOCAL.networkId, name, address);
  info(`${name} at ${address}`);
  return { name, address, deployed, providers, module };
}

async function readLedger(c: { address: string; providers: any; module: any }) {
  const state = await c.providers.publicDataProvider.queryContractState(c.address);
  if (!state) throw new Error(`${c.address} has no state on chain`);
  return c.module.ledger(state.data);
}

function shieldedBalance(state: any, colorHex: string): bigint {
  const balances = (state.shielded as any).balances as Record<string, bigint>;
  return balances[colorHex] ?? balances[`0x${colorHex}`] ?? 0n;
}

/** The wallet sees new coins a moment after the transaction that made them. */
function waitForBalance(wallet: BuiltWallet, colorHex: string, atLeast: bigint): Promise<bigint> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.map((s) => shieldedBalance(s, colorHex)),
      Rx.filter((b) => b >= atLeast),
      Rx.timeout(120_000)
    )
  );
}

function waitForBalanceBelow(wallet: BuiltWallet, colorHex: string, below: bigint): Promise<bigint> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.map((s) => shieldedBalance(s, colorHex)),
      Rx.filter((b) => b < below),
      Rx.timeout(120_000)
    )
  );
}

async function rawTransaction(indexer: string, hash: string): Promise<string> {
  const query = `query T($hash: HexEncoded!) {
    transactions(offset: { hash: $hash }) { ... on RegularTransaction { raw } }
  }`;
  const response = await fetch(indexer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { hash } }),
  });
  const body: any = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  const raw = body.data?.transactions?.[0]?.raw;
  if (!raw) throw new Error(`The indexer has no raw bytes for ${hash}`);
  return String(raw);
}

/** A number as it might appear in bytes: minimal and 8/16-byte padded, BE and LE. */
function encodings(n: bigint): string[] {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  const le = (s: string) => s.match(/../g)!.reverse().join("");
  const out = new Set([h, le(h)]);
  for (const width of [8, 16]) {
    const padded = h.padStart(width * 2, "0");
    out.add(padded).add(le(padded));
  }
  return [...out];
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
