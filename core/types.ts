// SPDX-License-Identifier: Apache-2.0

/** Types shared by the services, the scripts and the frontend. No runtime code. */

/** A trader's record of one position: the only copy of its opening. See core/positions.ts. */
export interface PositionRecord {
  /**
   * pending — written, open not yet confirmed; may or may not exist on chain.
   * open    — the commitment is in the positions tree.
   * failed  — the open was never accepted; nothing on chain to recover.
   * closed  — settled; kept as a record, holds nothing spendable.
   */
  status: "pending" | "open" | "failed" | "closed";
  contractAddress: string;
  networkId: string;
  /** hex */
  commitment: string;
  opening: {
    ownerSecret: string;
    isLong: boolean;
    size: string;
    /** Net of the opening fee; the coin holds collateral + openFee. */
    collateral: string;
    openFee: string;
    entryPrice: string;
    /** Seconds since the epoch. */
    openTime: string;
    collateralNonce: string;
    salt: string;
    /** hex: the coin public key of the wallet that opened it, the only one a close pays. */
    payTo: string;
  };
  createdAt: string;
  txHash?: string;
  closeTxHash?: string;
  /** How a closed position ended, once known. Amounts in pUSDC's smallest unit. */
  closing?: PositionClosing;
}

export interface PositionClosing {
  /** Closed by its owner, or liquidated by the keeper. */
  by: "trader" | "liquidation";
  exitPrice: string;
  /** Seconds since the epoch. */
  closeTime: string;
  /** Signed: the profit or loss before fees. */
  pnl: string;
  /** Close, borrow and liquidation fees; the opening fee is in `opening.openFee`. */
  fees: string;
  /** What the owner's wallet received. */
  received: string;
  /**
   * The fees as charged, when known: each is taken from what equity is left,
   * so in a wipe-out the sum may exceed `fees`, which is what was actually taken.
   */
  closeFee?: string;
  borrowFee?: string;
  liquidationFee?: string;
  /**
   * False when rebuilt from the closing transaction: the close time is then
   * the block's, so the borrow fee (and what was received) is an estimate.
   */
  exact: boolean;
}
