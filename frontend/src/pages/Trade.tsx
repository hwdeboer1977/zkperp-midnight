// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { openFeeOf } from "@core/math";
import { fmt6, parse6 } from "../lib/bytes";
import { useConfig, useLedger } from "../lib/hooks";
import { PriceMovedError, openPosition } from "../lib/trading";
import { balanceOf, useWallet } from "../lib/wallet";
import { NeedsWallet } from "../components/WalletButton";

/**
 * The largest size `coin` can carry at `leverage`, after the opening fee:
 * size ≤ leverage × (coin − fee(size)), the contract's own bound.
 */
function sizeFor(coin: bigint, leverage: bigint, feeBps: bigint): bigint {
  let size = (coin * leverage * 10_000n) / (10_000n + leverage * feeBps);
  while (size > 0n && size > leverage * (coin - openFeeOf(size, feeBps))) size -= 1n;
  return size;
}

export default function TradePage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const [isLong, setLong] = useState(true);
  const [coinText, setCoin] = useState("1000");
  const [leverage, setLeverage] = useState(5);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState<PriceMovedError | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  const coin = parse6(coinText);
  const plan = useMemo(() => {
    if (!ledger || !coin) return null;
    const feeBps = BigInt(ledger.openFeeBps);
    const size = sizeFor(coin, BigInt(leverage), feeBps);
    const fee = openFeeOf(size, feeBps);
    const net = coin - fee;
    const capMove = size > 0n ? Number((ledger.maxPayout * 10_000n) / size) / 100 : 0;
    return { size, fee, net, capMove };
  }, [ledger, coin, leverage]);

  const maxLeverage = ledger ? Number(ledger.maxLeverage) : 20;
  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;
  const problem = !ledger
    ? "Reading zkperp…"
    : !coin || !plan
      ? "Enter the collateral to post."
      : plan.net < ledger.minCollateral
        ? `Collateral after the fee must be at least ${fmt6(ledger.minCollateral)} pUSDC.`
        : coin > pusdc
          ? `Your wallet holds ${fmt6(pusdc)} pUSDC. Get more from the faucet.`
          : ledger.freeSlots < 1n
            ? "The pool has no room for another position right now."
            : null;

  async function submit(expectedPrice: bigint) {
    if (!coin || !plan) return;
    setBusy(true);
    setMoved(null);
    setOpened(null);
    try {
      setStatus("Preparing…");
      const perp = await w.contract("zkperp");
      setStatus(w.canProve ? "Proving in your wallet — this can take a minute…" : "Proving on the local proof server…");
      const { txHash } = await openPosition(perp, coin, plan.size, isLong, expectedPrice);
      setOpened(txHash);
      setStatus(null);
      void w.refresh();
    } catch (e: any) {
      if (e instanceof PriceMovedError) setMoved(e);
      setStatus(e instanceof PriceMovedError ? null : `Failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Trade</h1>
      <p className="lead">
        Your position is a commitment on chain: its size, collateral and direction stay private, and longs and shorts open
        identically. Profit is capped at {ledger ? fmt6(ledger.maxPayout, 0) : "…"} pUSDC per position; a loss stops at your
        collateral.
      </p>
      {!w.api && <NeedsWallet what="trade" />}
      <section className="card trade">
        <div className="toggle">
          <button className={isLong ? "on long" : ""} onClick={() => setLong(true)}>
            Long
          </button>
          <button className={!isLong ? "on short" : ""} onClick={() => setLong(false)}>
            Short
          </button>
        </div>
        <label>
          Collateral to post (pUSDC)
          <input value={coinText} onChange={(e) => setCoin(e.target.value)} inputMode="decimal" />
          {w.api && <small>wallet: {fmt6(pusdc)} pUSDC</small>}
        </label>
        <label>
          Leverage: {leverage}×
          <input type="range" min={1} max={maxLeverage} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
        </label>
        {plan && ledger && (
          <dl className="summary">
            <dt>Size</dt>
            <dd>{fmt6(plan.size)} pUSDC</dd>
            <dt>Entry price</dt>
            <dd>${fmt6(ledger.markPrice)}</dd>
            <dt>Opening fee ({Number(ledger.openFeeBps) / 100}%)</dt>
            <dd>{fmt6(plan.fee)} pUSDC</dd>
            <dt>Collateral after fee</dt>
            <dd>{fmt6(plan.net)} pUSDC</dd>
            <dt>Closing fee</dt>
            <dd>{fmt6(openFeeOf(plan.size, BigInt(ledger.closeFeeBps)))} pUSDC, at close</dd>
            <dt>Borrow fee</dt>
            <dd>
              {fmt6((plan.size * BigInt(ledger.borrowRate) * 3600n) / 1_000_000_000_000n, 4)} pUSDC per hour held
            </dd>
            <dt>Profit cap</dt>
            <dd>
              {fmt6(ledger.maxPayout, 0)} pUSDC — reached at a {plan.capMove.toFixed(1)}% move
            </dd>
          </dl>
        )}
        {w.api && (
          <button className="primary" disabled={!!problem || busy || !ledger} onClick={() => ledger && submit(ledger.markPrice)}>
            {busy ? "Working…" : `Open ${isLong ? "long" : "short"}`}
          </button>
        )}
        {problem && w.api && <p className="muted">{problem}</p>}
        {status && <p className={status.startsWith("Failed") ? "bad" : "muted"}>{status}</p>}
        {moved && (
          <div className="banner warn">
            The price moved from ${fmt6(moved.provenAt)} to ${fmt6(moved.now)} while proving. Nothing was opened.{" "}
            <button onClick={() => submit(moved.now)}>Open at ${fmt6(moved.now)}</button>
          </div>
        )}
        {opened && (
          <div className="banner ok">
            Position opened ({opened.slice(0, 12)}…). <b>Back up your positions now:</b> the opening exists only in this
            browser, and without it the position cannot be closed. <Link to="/portfolio">Go to Portfolio →</Link>
          </div>
        )}
      </section>
    </>
  );
}
