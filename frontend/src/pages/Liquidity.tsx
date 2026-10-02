// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { reservedOf } from "@core/math";
import { fmt6, hex, parse6 } from "../lib/bytes";
import { useConfig, useLedger } from "../lib/hooks";
import { addLiquidity, removeLiquidity } from "../lib/trading";
import { balanceOf, useWallet } from "../lib/wallet";
import { NeedsWallet } from "../components/WalletButton";

export default function LiquidityPage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const [deposit, setDeposit] = useState("1000");
  const [redeem, setRedeem] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;
  const zlp = ledger && ledger.lpSupply > 0n ? balanceOf(w.shieldedBalances, hex(ledger.lpToken)) : 0n;
  const value = (shares: bigint) => (ledger && ledger.lpSupply > 0n ? (shares * ledger.poolValue) / ledger.lpSupply : 0n);
  // Only what is not reserved for open positions can leave.
  const withdrawable = ledger ? ledger.poolValue - reservedOf(ledger) - (reservedOf(ledger) > 0n ? 1n : 0n) : 0n;

  async function run(label: string, f: () => Promise<string>) {
    setBusy(true);
    try {
      setStatus(`${label}: proving…`);
      const txHash = await f();
      setStatus(`${label}: done (${txHash.slice(0, 12)}…)`);
      void w.refresh();
    } catch (e: any) {
      setStatus(`${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  const depositAmount = parse6(deposit);
  const redeemShares = parse6(redeem);
  return (
    <>
      <h1>Liquidity</h1>
      <p className="lead">
        The pool is every trader's counterparty: it pays profits and keeps losses, and earns 70% of fees in epochs. Deposits
        and withdrawals are public. Liquidity reserved for open positions cannot be withdrawn.
      </p>
      {ledger && (
        <section className="stats">
          <div className="stat">
            <div className="label">Pool</div>
            <div className="value">{fmt6(ledger.poolValue, 0)} pUSDC</div>
            <div className="sub">{fmt6(value(1_000_000n), 4)} pUSDC per zLP</div>
          </div>
          <div className="stat">
            <div className="label">Withdrawable now</div>
            <div className="value">{fmt6(withdrawable > 0n ? withdrawable : 0n, 0)} pUSDC</div>
            <div className="sub">{fmt6(reservedOf(ledger), 0)} reserved</div>
          </div>
          {w.api && (
            <div className="stat">
              <div className="label">Your zLP</div>
              <div className="value">{fmt6(zlp, 2)}</div>
              <div className="sub">worth {fmt6(value(zlp))} pUSDC</div>
            </div>
          )}
        </section>
      )}
      {!w.api ? (
        <NeedsWallet what="provide liquidity" />
      ) : (
        <section className="two">
          <div className="card">
            <h2>Deposit</h2>
            <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
            <small className="muted">wallet: {fmt6(pusdc)} pUSDC</small>
            <button
              className="primary"
              disabled={busy || !depositAmount || depositAmount > pusdc}
              onClick={() => depositAmount && run("Deposit", async () => addLiquidity(await w.contract("zkperp"), depositAmount))}
            >
              Deposit pUSDC
            </button>
          </div>
          <div className="card">
            <h2>Withdraw</h2>
            <input placeholder="zLP to redeem" value={redeem} onChange={(e) => setRedeem(e.target.value)} inputMode="decimal" />
            {redeemShares ? <small className="muted">≈ {fmt6(value(redeemShares))} pUSDC</small> : null}
            <button
              className="primary"
              disabled={busy || !redeemShares || redeemShares > zlp}
              onClick={() =>
                redeemShares && run("Withdraw", async () => (await removeLiquidity(await w.contract("zkperp"), redeemShares)).txHash)
              }
            >
              Redeem zLP
            </button>
          </div>
        </section>
      )}
      {status && <p className={/failed/.test(status) ? "bad" : "muted"}>{status}</p>}
    </>
  );
}
