// SPDX-License-Identifier: Apache-2.0

/**
 * The LP's side of zkperp: redeeming zLP shares for pool liquidity.
 */

import { randomBytes } from "crypto";
import { capacityOf, readLedger, type ContractHandle } from "./perp.js";

/** pUSDC that `shares` redeem for, as the circuit demands: rounded down, for the pool. */
export function redeemable(ledger: { poolValue: bigint; lpSupply: bigint }, shares: bigint): bigint {
  if (ledger.lpSupply === 0n) return 0n;
  return (shares * ledger.poolValue) / ledger.lpSupply;
}

/**
 * Redeems `shares` zLP for their part of the pool, paid to the wallet behind
 * `perp.providers`. Refused if it would leave the pool at or below the
 * liquidity reserved for open positions.
 */
export async function removeLiquidity(
  perp: ContractHandle,
  shares: bigint
): Promise<{ txHash: string; amount: bigint }> {
  const ledger = await readLedger(perp);
  const amount = redeemable(ledger, shares);
  const tx = await perp.deployed.callTx.removeLiquidity(
    { nonce: new Uint8Array(randomBytes(32)), color: ledger.lpToken, value: shares },
    amount,
    capacityOf(ledger.poolValue - amount, ledger.maxPayout)
  );
  return { txHash: tx.public.txHash, amount };
}

/**
 * The treasury's epoch payment: adds `amount` pUSDC to the pool without
 * minting shares, raising every zLP share's value.
 */
export async function depositFees(perp: ContractHandle, usdc: Uint8Array, amount: bigint): Promise<string> {
  const ledger = await readLedger(perp);
  const tx = await perp.deployed.callTx.depositFees(
    { nonce: new Uint8Array(randomBytes(32)), color: usdc, value: amount },
    capacityOf(ledger.poolValue + amount, ledger.maxPayout)
  );
  return tx.public.txHash;
}

/**
 * Deposits `amount` pUSDC for zLP shares: one share per unit for the first
 * deposit, pro rata after that, rounded down for the pool.
 */
export async function addLiquidity(perp: ContractHandle, usdc: Uint8Array, amount: bigint): Promise<string> {
  const ledger = await readLedger(perp);
  const shares = ledger.lpSupply === 0n ? amount : (amount * ledger.lpSupply) / ledger.poolValue;
  const tx = await perp.deployed.callTx.addLiquidity(
    { nonce: new Uint8Array(randomBytes(32)), color: usdc, value: amount },
    shares,
    capacityOf(ledger.poolValue + amount, ledger.maxPayout)
  );
  return tx.public.txHash;
}
