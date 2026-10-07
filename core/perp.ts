// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's side of zkperp: opening and closing positions, long or short.
 *
 * Everything that makes a position closable lives off chain, in
 * `.zkperp/positions.json` (see positions.ts). This module is where that
 * record is turned back into the arguments `closePosition` needs — including the
 * one the chain has but will not hand over by name: the collateral coin's
 * Merkle index.
 */

import { randomBytes } from "crypto";
import {
  ShieldedCoinInfoDescriptor,
  ShieldedCoinRecipientDescriptor,
  runtimeCoinCommitment,
} from "@midnight-ntwrk/compact-runtime";
import { withContractScopedTransaction } from "@midnight-ntwrk/midnight-js-contracts";
import { confirmOpen, markClosed, markFailed, recordPending, type PositionRecord } from "./positions.js";
import { NOTE_BYTES } from "./notes.js";
import { belowField, decodeLiquidatorPlaintext, randomScalar, type LiquidatorView } from "./liquidatorNote.js";
import {
  borrowFeeOf,
  capacityOf,
  circuitNow,
  closeFeeOf,
  isLiquidatable,
  liquidationFeeOf,
  openFeeOf,
  positionPnl,
  settlement,
} from "./math.js";

export * from "./math.js";

export interface ContractHandle {
  address: string;
  deployed: any;
  providers: any;
  module: any;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The oracle's update: `price` observed at `updatedAt` (seconds since the
 * epoch; for Chainlink, the round's `updatedAt`). Defaults to now, as the
 * mock oracle in the demo has no feed of its own.
 */
export async function submitPrice(
  perp: ContractHandle,
  price: bigint,
  adminSecret: Uint8Array,
  updatedAt: bigint = circuitNow()
): Promise<string> {
  const tx = await perp.deployed.callTx.setPrice(price, updatedAt, adminSecret);
  return tx.public.txHash;
}

export async function readLedger(c: ContractHandle): Promise<any> {
  const state = await c.providers.publicDataProvider.queryContractState(c.address);
  if (!state) throw new Error(`${c.address} has no state on chain`);
  return c.module.ledger(state.data);
}

/** The circuit's `Position` struct, rebuilt from a saved record. */
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

/** The coin public key of the wallet behind `perp.providers`: what `ownPublicKey()` returns in a circuit. */
export function walletCoinKey(perp: ContractHandle): string {
  return String(perp.providers.walletProvider.getCoinPublicKey()).replace(/^0x/, "");
}

/** 32 bytes as the two 16-byte halves the open circuit takes. */
export const halvesOf = (b: Uint8Array): [Uint8Array, Uint8Array] => [b.slice(0, 16), b.slice(16, 32)];

/** The same wallet's encryption public key, which the liquidator note carries. */
export function walletEncKey(perp: ContractHandle): Uint8Array {
  return bytes(String(perp.providers.walletProvider.getEncryptionPublicKey()));
}

export interface Opened {
  record: PositionRecord;
  txHash: string;
}

/**
 * Opens a long or a short for the wallet behind `perp.providers`, posting a
 * coin of `coinValue`. The opening fee comes out of it; the rest is the
 * position's collateral. The opening is saved BEFORE submitting and marked
 * open or failed after; see positions.ts.
 */
export async function openPosition(
  perp: ContractHandle,
  usdc: Uint8Array,
  coinValue: bigint,
  size: bigint,
  isLong: boolean,
  networkId: string
): Promise<Opened> {
  const ledger = await readLedger(perp);
  const openFee = openFeeOf(size, BigInt(ledger.openFeeBps));
  const openTime = circuitNow();
  const ownerSecret = new Uint8Array(randomBytes(32));
  const record: PositionRecord = {
    status: "pending",
    contractAddress: perp.address,
    networkId,
    commitment: "",
    createdAt: new Date().toISOString(),
    opening: {
      ownerSecret: hex(ownerSecret),
      isLong,
      size: size.toString(),
      collateral: (coinValue - openFee).toString(),
      openFee: openFee.toString(),
      entryPrice: ledger.markPrice.toString(),
      openTime: openTime.toString(),
      collateralNonce: hex(belowField(randomBytes(32))),
      salt: hex(belowField(randomBytes(32))),
      payTo: walletCoinKey(perp),
    },
  };
  const position = positionOf(perp, record);
  record.commitment = hex(perp.module.pureCircuits.positionCommitment(position));

  recordPending(record);
  try {
    const tx = await perp.deployed.callTx.openPosition(
      { nonce: position.collateralNonce, color: usdc, value: coinValue },
      size,
      isLong,
      openFee,
      openTime,
      ownerSecret,
      position.salt,
      // The CLI keeps its openings in .zkperp/positions.json and writes no
      // real note. Random bytes look on chain exactly like one.
      new Uint8Array(randomBytes(NOTE_BYTES)),
      randomScalar(),
      ...halvesOf(position.payTo.bytes),
      ...halvesOf(walletEncKey(perp))
    );
    const txHash: string = tx.public.txHash;
    confirmOpen(record.commitment, txHash);
    return { record: { ...record, status: "open", txHash }, txHash };
  } catch (error) {
    // Refused before landing: the collateral never left the wallet.
    markFailed(record.commitment);
    throw error;
  }
}

/**
 * The contract's coins, as Merkle leaf index → coin commitment.
 *
 * The indexer's zswap state can be filtered to one contract's coins, but it
 * reports every coin the contract ever received, spent or not, and only by
 * commitment — which is why a coin is found by rebuilding its commitment,
 * never by position. From midnight-polisZK's fund-pool.ts.
 */
async function contractCoinLeaves(perp: ContractHandle): Promise<Map<string, number>> {
  const result = await perp.providers.publicDataProvider.queryZSwapAndContractState(perp.address);
  const leaves = new Map<string, number>();
  if (!result) return leaves;
  const [zswap] = result as any;
  const text = String(zswap.filter(perp.address).toString(true));
  for (const m of text.matchAll(/(\d+): \(([0-9a-f]{64}), Some\(ContractAddress/g)) {
    leaves.set(m[2]!, Number(m[1]));
  }
  return leaves;
}

/** The commitment of a coin owned by `contractAddress`, hex. */
function contractCoinCommitment(
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
  contractAddress: string
): string {
  return hex(
    runtimeCoinCommitment(
      { value: ShieldedCoinInfoDescriptor.toValue(coin), alignment: ShieldedCoinInfoDescriptor.alignment() } as any,
      {
        // Both branches must be present, or the WASM fails with an error that
        // names nothing ("Reflect.get called on non-object").
        value: ShieldedCoinRecipientDescriptor.toValue({
          is_left: false,
          left: { bytes: new Uint8Array(32) },
          right: { bytes: bytes(contractAddress) },
        }),
        alignment: ShieldedCoinRecipientDescriptor.alignment(),
      } as any
    ).value[0] as Uint8Array
  );
}

/** Where the collateral coin sits in the Zswap tree. Waits out indexer lag. */
export async function collateralIndex(
  perp: ContractHandle,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }
): Promise<bigint> {
  const target = contractCoinCommitment(coin, perp.address);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const index = (await contractCoinLeaves(perp)).get(target);
    if (index !== undefined) return BigInt(index);
    if (Date.now() > deadline) {
      throw new Error(
        `The collateral coin ${target.slice(0, 16)}… is not among the contract's coins. ` +
          "Either the open never landed or the indexer is far behind."
      );
    }
    await sleep(2000);
  }
}

export interface Closed {
  txHash: string;
  profit: boolean;
  capped: boolean;
  pnl: bigint;
  exit: bigint;
  closeFee: bigint;
  borrowFee: bigint;
  /** Seconds the position was held. */
  held: bigint;
  settled: ReturnType<typeof settlement>;
  nullifier: Uint8Array;
}

/**
 * Closes a position at the current mark price. The payout goes to the wallet
 * that opened it (`opening.payTo`), whichever wallet submits the close.
 *
 * The close creates a shielded output to the treasury, and a shielded output
 * is encrypted to its recipient so their wallet can find it. The contract
 * stores only the treasury's coin key; its encryption key, `treasuryEncKey`,
 * has to come from the treasury itself, like any payee's address.
 */
export async function closePosition(
  perp: ContractHandle,
  record: PositionRecord,
  usdc: Uint8Array,
  treasuryEncKey: string
): Promise<Closed> {
  if (record.status !== "open") throw new Error(`position ${record.commitment.slice(0, 12)}… is ${record.status}`);
  const position = positionOf(perp, record);
  const ledger = await readLedger(perp);

  const path = ledger.positions.findPathForLeaf(bytes(record.commitment));
  if (!path) throw new Error("the position's commitment is not in the tree");

  const coin = { nonce: position.collateralNonce, color: usdc, value: position.collateral + position.openFee };
  const mt_index = await collateralIndex(perp, coin);

  const exit: bigint = ledger.markPrice;
  const { profit, pnl, capped } = positionPnl(
    position.isLong,
    position.size,
    position.entryPrice,
    exit,
    ledger.maxPayout
  );
  const ownerSecret = bytes(record.opening.ownerSecret);
  const closeTime = circuitNow();
  const held = closeTime - position.openTime;
  const closeFee = closeFeeOf(position.size, BigInt(ledger.closeFeeBps));
  const borrowFee = borrowFeeOf(position.size, BigInt(ledger.borrowRate), held);
  const settled = settlement(position, { profit, pnl }, closeFee, borrowFee);
  // Ignored by the contract at an unchanged price, when the pool does not move.
  const capacity = capacityOf(ledger.poolValue + settled.toPool - settled.fromPool, ledger.maxPayout);

  const tx: any = await withContractScopedTransaction(
    perp.providers,
    (txCtx: any) =>
      perp.deployed.callTx.closePosition(
        txCtx,
        position,
        ownerSecret,
        path,
        { ...coin, mt_index },
        pnl,
        closeFee,
        borrowFee,
        closeTime,
        capacity
      ),
    { additionalCoinEncPublicKeyMappings: new Map([[hex(ledger.treasury.bytes), treasuryEncKey]]) }
  );
  const txHash: string = tx.public.txHash;
  markClosed(record.commitment, txHash);
  return {
    txHash,
    profit,
    capped,
    pnl,
    exit,
    closeFee,
    borrowFee,
    held,
    settled,
    nullifier: perp.module.pureCircuits.positionNullifier(position.salt),
  };
}

// ── Liquidation: the keeper's side ───────────────────────────────────────────

/** A live position the keeper can read: its liquidator note opened, its commitment in the tree, not yet closed. */
export interface Watched extends LiquidatorView {
  commitment: string;
}

/**
 * Every live position whose liquidator note opens under `secret`. A note under
 * another key decodes to garbage or to a commitment that is not in the tree,
 * and is skipped.
 */
export function watchedPositions(perp: ContractHandle, ledger: any, secret: bigint): Watched[] {
  const out: Watched[] = [];
  for (const note of ledger.liquidatorNotes as Iterable<any>) {
    let view: LiquidatorView;
    try {
      view = decodeLiquidatorPlaintext(perp.module.pureCircuits.openLiquidatorNote(note, secret));
    } catch {
      continue;
    }
    const commitment = perp.module.pureCircuits.positionCommitment(view.position) as Uint8Array;
    if (!ledger.positions.findPathForLeaf(commitment)) continue;
    if (ledger.closed.member(perp.module.pureCircuits.positionNullifier(view.position.salt))) continue;
    out.push({ ...view, commitment: hex(commitment) });
  }
  return out;
}

/** Whether `w` is below maintenance margin at the ledger's price, as the circuit tests it. */
export function canLiquidate(ledger: any, w: Watched, closeTime = circuitNow()): boolean {
  return isLiquidatable(w.position, ledger, closeTime);
}

export interface Liquidated {
  txHash: string;
  pnl: bigint;
  liquidationFee: bigint;
  settled: ReturnType<typeof settlement>;
}

/**
 * Liquidates `w` at the current mark price, from the keeper's wallet behind
 * `perp.providers`. The equity left goes to the trader's `payTo`, encrypted
 * to the key their liquidator note carries; the fees go to the treasury.
 */
export async function liquidatePosition(
  perp: ContractHandle,
  w: Watched,
  usdc: Uint8Array,
  treasuryEncKey: string
): Promise<Liquidated> {
  const ledger = await readLedger(perp);
  const path = ledger.positions.findPathForLeaf(bytes(w.commitment));
  if (!path) throw new Error("the position's commitment is not in the tree");
  const p = w.position;
  const coin = { nonce: p.collateralNonce, color: usdc, value: p.collateral + p.openFee };
  const mt_index = await collateralIndex(perp, coin);

  const { profit, pnl } = positionPnl(p.isLong, p.size, p.entryPrice, ledger.markPrice, ledger.maxPayout);
  const closeTime = circuitNow();
  const closeFee = closeFeeOf(p.size, BigInt(ledger.closeFeeBps));
  const borrowFee = borrowFeeOf(p.size, BigInt(ledger.borrowRate), closeTime - p.openTime);
  const liquidationFee = liquidationFeeOf(p.size, BigInt(ledger.liquidationFeeBps));
  const settled = settlement(p, { profit, pnl }, closeFee, borrowFee, liquidationFee);
  const capacity = capacityOf(ledger.poolValue + settled.toPool - settled.fromPool, ledger.maxPayout);

  const tx: any = await withContractScopedTransaction(
    perp.providers,
    (txCtx: any) =>
      perp.deployed.callTx.liquidatePosition(
        txCtx,
        p,
        path,
        { ...coin, mt_index },
        pnl,
        closeFee,
        borrowFee,
        liquidationFee,
        closeTime,
        capacity
      ),
    {
      additionalCoinEncPublicKeyMappings: new Map([
        [hex(ledger.treasury.bytes), treasuryEncKey],
        [hex(p.payTo.bytes), hex(w.payToEnc)],
      ]),
    }
  );
  return { txHash: tx.public.txHash, pnl, liquidationFee, settled };
}
