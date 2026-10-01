// SPDX-License-Identifier: Apache-2.0

/**
 * The LP's side of zkperp: redeeming zLP shares for pool liquidity.
 */

import { randomBytes } from "crypto";
import { readLedger, type ContractHandle } from "./perp.js";

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
    amount
  );
  return { txHash: tx.public.txHash, amount };
}
