// SPDX-License-Identifier: Apache-2.0

/**
 * Opening and closing positions, and the pool operations, from the browser.
 *
 * The same orchestration as core/perp.ts, with the arithmetic shared from
 * core/math.ts — the copy the tests and the devnet demo verify. What differs
 * is where records live (IndexedDB, see positions.ts), that randomness comes
 * from WebCrypto, and that an open's secrets derive from the position key and
 * its opening goes on chain as a note (core/notes.ts), so the position can be
 * found and closed from any device.
 *
 * Concurrency (measured on the devnet, see README "Concurrent trades"):
 *
 *   · a trade proven at one price fails if the price changes before it lands
 *     — `PriceMovedError`, so the UI can show the new price and ask again;
 *   · two closes that settle against the pool spend the same pool coin; the
 *     loser is rejected before inclusion, at no cost, and retried here.
 */

import { ShieldedCoinInfoDescriptor, ShieldedCoinRecipientDescriptor, runtimeCoinCommitment } from "@midnight-ntwrk/compact-runtime";
import { withContractScopedTransaction } from "@midnight-ntwrk/midnight-js-contracts";
import {
  borrowFeeOf,
  capacityOf,
  circuitNow,
  closeFeeOf,
  openFeeOf,
  positionPnl,
  settlement,
} from "@core/math";
import { sealNote, secretsOf, type PositionKey } from "@core/notes";
import { randomScalar } from "@core/liquidatorNote";

const halvesOf = (b: Uint8Array): [Uint8Array, Uint8Array] => [b.slice(0, 16), b.slice(16, 32)];
import { bytes, hex, keyBytes, random32 } from "./bytes";
import { loadConfig } from "./config";
import { putPosition, updatePosition, type PositionRecord } from "./positions";
import type { ContractHandle } from "./providers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ledgerOf(perp: ContractHandle): Promise<any> {
  const state = await perp.providers.publicDataProvider.queryContractState(perp.address);
  if (!state) throw new Error("zkperp has no state on chain");
  return perp.module.ledger(state.data);
}

/** The price changed between proving and landing: re-check, then try again. */
export class PriceMovedError extends Error {
  constructor(public readonly provenAt: bigint, public readonly now: bigint) {
    super("The price moved while the transaction was being proven.");
  }
}

const isPoolConflict = (e: unknown) =>
  /NullifierAlreadyPresent|SubmissionError|Transaction submission error/.test(String((e as any)?.message ?? e));

/**
 * Runs `attempt`, proven against `provenPrice`. A failure after which the
 * price differs becomes PriceMovedError; a pool-coin conflict is retried.
 */
async function withConflicts<T>(perp: ContractHandle, provenPrice: bigint, attempt: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      const now: bigint = (await ledgerOf(perp)).markPrice;
      if (now !== provenPrice) throw new PriceMovedError(provenPrice, now);
      if (i < retries && isPoolConflict(error)) {
        await sleep(3000);
        continue;
      }
      throw error;
    }
  }
}

export function positionOf(perp: ContractHandle, record: PositionRecord) {
  const o = record.opening;
  return {
    owner: perp.module.pureCircuits.ownerKey(bytes(o.ownerSecret)) as Uint8Array,
    isLong: o.isLong,
    size: BigInt(o.size),
    collateral: BigInt(o.collateral),
    openFee: BigInt(o.openFee),
    entryPrice: BigInt(o.entryPrice),
    openTime: BigInt(o.openTime),
    collateralNonce: bytes(o.collateralNonce),
    salt: bytes(o.salt),
    payTo: { bytes: bytes(o.payTo) },
  };
}

/** The connected wallet's coin public key, hex: what `ownPublicKey()` returns in a circuit. */
export function walletCoinKey(perp: ContractHandle): string {
  return hex(keyBytes(String(perp.providers.walletProvider.getCoinPublicKey())));
}

/**
 * Opens a position posting a coin of `coinValue`; the opening fee comes out of
 * it. `expectedPrice` is the price the trader saw: if it has moved, nothing is
 * submitted. The owner secret, salt and coin nonce derive from `key` and a
 * fresh seed, and the opening is sealed under `key` into the open's note.
 */
export async function openPosition(
  perp: ContractHandle,
  key: PositionKey,
  coinValue: bigint,
  size: bigint,
  isLong: boolean,
  expectedPrice: bigint
): Promise<{ record: PositionRecord; txHash: string }> {
  const config = await loadConfig();
  const ledger = await ledgerOf(perp);
  if (ledger.markPrice !== expectedPrice) throw new PriceMovedError(expectedPrice, ledger.markPrice);
  const openFee = openFeeOf(size, BigInt(ledger.openFeeBps));
  const openTime = circuitNow();
  const seed = random32();
  const { ownerSecret, salt, collateralNonce } = await secretsOf(key, seed);
  const collateral = coinValue - openFee;
  const note = await sealNote(key, bytes(perp.address), {
    seed,
    isLong,
    size,
    collateral,
    openFee,
    entryPrice: ledger.markPrice,
    openTime,
  });
  const record: PositionRecord = {
    status: "pending",
    contractAddress: perp.address,
    networkId: config.network.networkId,
    commitment: "",
    createdAt: new Date().toISOString(),
    opening: {
      ownerSecret: hex(ownerSecret),
      isLong,
      size: size.toString(),
      collateral: collateral.toString(),
      openFee: openFee.toString(),
      entryPrice: ledger.markPrice.toString(),
      openTime: openTime.toString(),
      collateralNonce: hex(collateralNonce),
      salt: hex(salt),
      payTo: walletCoinKey(perp),
    },
  };
  const position = positionOf(perp, record);
  record.commitment = hex(perp.module.pureCircuits.positionCommitment(position));

  // Written before submitting: a crash after this leaves a pending record that
  // still holds everything needed to close, never a position nobody can describe.
  await putPosition(record);
  try {
    const tx = await withConflicts(perp, ledger.markPrice, () =>
      perp.deployed.callTx.openPosition(
        { nonce: position.collateralNonce, color: bytes(config.usdcToken), value: coinValue },
        size,
        isLong,
        openFee,
        openTime,
        ownerSecret,
        position.salt,
        note,
        // A fresh scalar per open: the liquidator note's ephemeral key.
        randomScalar(),
        // The payout key in halves, which the circuit ties to the commitment's, and
        // the encryption key, so the keeper can return any equity a liquidation
        // leaves to this wallet, visibly. Both go only into the liquidator note.
        ...halvesOf(position.payTo.bytes),
        ...halvesOf(keyBytes(String(perp.providers.walletProvider.getEncryptionPublicKey())))
      )
    );
    const txHash: string = (tx as any).public.txHash;
    await updatePosition(record.commitment, { status: "open", txHash });
    return { record: { ...record, status: "open", txHash }, txHash };
  } catch (error) {
    // Refused or failed: no position, and the coin never left the wallet.
    await updatePosition(record.commitment, { status: "failed" });
    throw error;
  }
}

// ── Finding the collateral coin ──────────────────────────────────────────────

async function contractCoinLeaves(perp: ContractHandle): Promise<Map<string, number>> {
  const result = await perp.providers.publicDataProvider.queryZSwapAndContractState(perp.address);
  const leaves = new Map<string, number>();
  if (!result) return leaves;
  const [zswap] = result as any;
  const text = String(zswap.filter(perp.address).toString(true));
  for (const m of text.matchAll(/(\d+): \(([0-9a-f]{64}), Some\(ContractAddress/g)) leaves.set(m[2]!, Number(m[1]));
  return leaves;
}

// The runtime returns the commitment as a field-style value, with its trailing
// zero bytes trimmed: one coin in 256 ends in a zero byte and would never
// match the indexer's 32 bytes. Padded back to 64 hex characters.
function contractCoinCommitment(coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }, contractAddress: string): string {
  return hex(
    runtimeCoinCommitment(
      { value: ShieldedCoinInfoDescriptor.toValue(coin), alignment: ShieldedCoinInfoDescriptor.alignment() } as any,
      {
        // Both branches must be present, or the WASM fails with an error that names nothing.
        value: ShieldedCoinRecipientDescriptor.toValue({
          is_left: false,
          left: { bytes: new Uint8Array(32) },
          right: { bytes: bytes(contractAddress) },
        }),
        alignment: ShieldedCoinRecipientDescriptor.alignment(),
      } as any
    ).value[0] as Uint8Array
  ).padEnd(64, "0");
}

/** The contract's Merkle index of the coin it holds for `coin`; waits for the indexer to show it. */
export async function collateralIndex(perp: ContractHandle, coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }): Promise<bigint> {
  const target = contractCoinCommitment(coin, perp.address);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const index = (await contractCoinLeaves(perp)).get(target);
    if (index !== undefined) return BigInt(index);
    if (Date.now() > deadline) throw new Error("The collateral coin is not among the contract's coins: did the open land?");
    await sleep(2000);
  }
}

/** What closing `record` at the current price would settle to. Read-only. */
export async function quoteClose(perp: ContractHandle, record: PositionRecord, ledger?: any, closeTime = circuitNow()) {
  const l = ledger ?? (await ledgerOf(perp));
  const position = positionOf(perp, record);
  const pnl = positionPnl(position.isLong, position.size, position.entryPrice, l.markPrice, l.maxPayout);
  const closeFee = closeFeeOf(position.size, BigInt(l.closeFeeBps));
  const borrowFee = borrowFeeOf(position.size, BigInt(l.borrowRate), closeTime - position.openTime);
  return { ...pnl, exit: l.markPrice as bigint, closeTime, closeFee, borrowFee, settled: settlement(position, pnl, closeFee, borrowFee) };
}

/**
 * Closes `record` at the current mark price. The payout goes to the wallet that
 * opened it (`opening.payTo`). `expectedPrice` is the price the trader confirmed.
 */
export async function closePosition(
  perp: ContractHandle,
  record: PositionRecord,
  expectedPrice: bigint
): Promise<{ txHash: string; quote: Awaited<ReturnType<typeof quoteClose>> }> {
  if (record.status !== "open") throw new Error(`this position is ${record.status}`);
  const config = await loadConfig();
  const position = positionOf(perp, record);
  const ledger = await ledgerOf(perp);
  if (ledger.markPrice !== expectedPrice) throw new PriceMovedError(expectedPrice, ledger.markPrice);

  const path = ledger.positions.findPathForLeaf(bytes(record.commitment));
  if (!path) throw new Error("The position's commitment is not in the tree.");
  const coin = { nonce: position.collateralNonce, color: bytes(config.usdcToken), value: position.collateral + position.openFee };
  const mt_index = await collateralIndex(perp, coin);

  const attempt = async () => {
    // Re-read per attempt: a retry after a pool conflict sees the new pool.
    const l = await ledgerOf(perp);
    const q = await quoteClose(perp, record, l);
    const capacity = capacityOf(l.poolValue + q.settled.toPool - q.settled.fromPool, l.maxPayout);
    const tx: any = await withContractScopedTransaction(
      perp.providers,
      (txCtx: any) =>
        perp.deployed.callTx.closePosition(
          txCtx,
          position,
          bytes(record.opening.ownerSecret),
          path,
          { ...coin, mt_index },
          q.pnl,
          q.closeFee,
          q.borrowFee,
          q.closeTime,
          capacity
        ),
      // The fees go to the treasury as a shielded output, encrypted to its key.
      { additionalCoinEncPublicKeyMappings: new Map([[config.treasury.coinPublicKey, config.treasury.encryptionPublicKey]]) }
    );
    return { txHash: tx.public.txHash as string, quote: q };
  };
  const result = await withConflicts(perp, ledger.markPrice, attempt);
  const q = result.quote;
  await updatePosition(record.commitment, {
    status: "closed",
    closeTxHash: result.txHash,
    closing: {
      by: "trader",
      exitPrice: q.exit.toString(),
      closeTime: q.closeTime.toString(),
      pnl: (q.profit ? q.pnl : -q.pnl).toString(),
      fees: (q.closeFee + q.borrowFee).toString(),
      received: q.settled.toTrader.toString(),
      closeFee: q.closeFee.toString(),
      borrowFee: q.borrowFee.toString(),
      liquidationFee: "0",
      exact: true,
    },
  });
  return result;
}

// ── Liquidity and the faucet ─────────────────────────────────────────────────

export async function addLiquidity(perp: ContractHandle, amount: bigint): Promise<string> {
  const config = await loadConfig();
  const l = await ledgerOf(perp);
  const shares = l.lpSupply === 0n ? amount : (amount * l.lpSupply) / l.poolValue;
  const tx = await perp.deployed.callTx.addLiquidity(
    { nonce: random32(), color: bytes(config.usdcToken), value: amount },
    shares,
    capacityOf(l.poolValue + amount, l.maxPayout)
  );
  return tx.public.txHash;
}

export async function removeLiquidity(perp: ContractHandle, shares: bigint): Promise<{ txHash: string; amount: bigint }> {
  const l = await ledgerOf(perp);
  const amount = (shares * l.poolValue) / l.lpSupply;
  const tx = await perp.deployed.callTx.removeLiquidity(
    { nonce: random32(), color: l.lpToken, value: shares },
    amount,
    capacityOf(l.poolValue - amount, l.maxPayout)
  );
  return { txHash: tx.public.txHash, amount };
}

/** pUSDC is a mock: anyone may mint any amount. */
export async function mintPusdc(pusdc: ContractHandle, amount: bigint): Promise<string> {
  const tx = await pusdc.deployed.callTx.mint(amount);
  return tx.public.txHash;
}
