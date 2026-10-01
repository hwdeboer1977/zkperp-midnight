// SPDX-License-Identifier: Apache-2.0

/**
 * The trader's side of zkperp: opening and closing longs.
 *
 * Everything that makes a position closable lives off chain, in
 * `.zkperp/positions.json` (see positions.ts). This module is where that
 * record is turned back into the arguments `closeLong` needs — including the
 * one the chain has but will not hand over by name: the collateral coin's
 * Merkle index.
 */

import { randomBytes } from "crypto";
import {
  ShieldedCoinInfoDescriptor,
  ShieldedCoinRecipientDescriptor,
  runtimeCoinCommitment,
} from "@midnight-ntwrk/compact-runtime";
import { confirmOpen, markClosed, markFailed, recordPending, type PositionRecord } from "./positions.js";

export interface ContractHandle {
  address: string;
  deployed: any;
  providers: any;
  module: any;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    entryPrice: BigInt(o.entryPrice),
    collateralNonce: bytes(o.collateralNonce),
    salt: bytes(o.salt),
  };
}

export interface Opened {
  record: PositionRecord;
  txHash: string;
}

/**
 * Opens a long for the wallet behind `perp.providers`. The opening is saved
 * BEFORE submitting and marked open or failed after; see positions.ts.
 */
export async function openLong(
  perp: ContractHandle,
  usdc: Uint8Array,
  collateral: bigint,
  size: bigint,
  networkId: string
): Promise<Opened> {
  const ledger = await readLedger(perp);
  const ownerSecret = new Uint8Array(randomBytes(32));
  const record: PositionRecord = {
    status: "pending",
    contractAddress: perp.address,
    networkId,
    commitment: "",
    createdAt: new Date().toISOString(),
    opening: {
      ownerSecret: hex(ownerSecret),
      isLong: true,
      size: size.toString(),
      collateral: collateral.toString(),
      entryPrice: ledger.markPrice.toString(),
      collateralNonce: hex(randomBytes(32)),
      salt: hex(randomBytes(32)),
    },
  };
  const position = positionOf(perp, record);
  record.commitment = hex(perp.module.pureCircuits.positionCommitment(position));

  recordPending(record);
  try {
    const tx = await perp.deployed.callTx.openLong(
      { nonce: position.collateralNonce, color: usdc, value: collateral },
      size,
      ownerSecret,
      position.salt
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
 * |PnL| of a long at `exit`, as the circuit demands: a profit rounded down and
 * capped at `maxPayout`, a loss rounded up — each in the pool's favour.
 */
export function longPnl(
  size: bigint,
  entry: bigint,
  exit: bigint,
  maxPayout: bigint
): { profit: boolean; pnl: bigint; capped: boolean } {
  if (exit >= entry) {
    const raw = (size * (exit - entry)) / entry;
    return raw > maxPayout
      ? { profit: true, pnl: maxPayout, capped: true }
      : { profit: true, pnl: raw, capped: false };
  }
  const drop = size * (entry - exit);
  return { profit: false, pnl: (drop + entry - 1n) / entry, capped: false };
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
  nullifier: Uint8Array;
}

/**
 * Closes a long at the current mark price, paying out to the wallet behind
 * `perp.providers` (whose coin public key is `recipient`).
 */
export async function closeLong(
  perp: ContractHandle,
  record: PositionRecord,
  usdc: Uint8Array,
  recipient: Uint8Array
): Promise<Closed> {
  if (record.status !== "open") throw new Error(`position ${record.commitment.slice(0, 12)}… is ${record.status}`);
  const position = positionOf(perp, record);
  const ledger = await readLedger(perp);

  const path = ledger.positions.findPathForLeaf(bytes(record.commitment));
  if (!path) throw new Error("the position's commitment is not in the tree");

  const coin = { nonce: position.collateralNonce, color: usdc, value: position.collateral };
  const mt_index = await collateralIndex(perp, coin);

  const exit: bigint = ledger.markPrice;
  const { profit, pnl, capped } = longPnl(position.size, position.entryPrice, exit, ledger.maxPayout);
  const ownerSecret = bytes(record.opening.ownerSecret);

  const tx = await perp.deployed.callTx.closeLong(
    position,
    ownerSecret,
    path,
    { ...coin, mt_index },
    pnl,
    { bytes: recipient }
  );
  const txHash: string = tx.public.txHash;
  markClosed(record.commitment, txHash);
  return {
    txHash,
    profit,
    capped,
    pnl,
    exit,
    nullifier: perp.module.pureCircuits.positionNullifier(ownerSecret, position.salt),
  };
}
