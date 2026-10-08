// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { reservedOf } from "@core/math";
import { fmt6, hex, parse6 } from "../lib/bytes";
import { useConfig, useLedger, useNow, useService, useShareHistory } from "../lib/hooks";
import { addLiquidity, removeLiquidity } from "../lib/trading";
import { balanceOf, useWallet } from "../lib/wallet";
import { PriceChart, Stat } from "../components/Market";
import { ProverLine, ProverSetup } from "../components/ProverSetup";

interface Epoch {
  at: string;
  closedPositions: string;
  deposited: string;
  txHash: string;
}

interface TreasuryHealth {
  closesSinceLastEpoch: number;
  secondsSinceLastEpoch: number | null;
  rules: { minCloses: number; minSeconds: number; lpSharePct: number };
}

const ONE = 1_000_000n;
const pctOf = (num: bigint, den: bigint, digits = 2) => (den === 0n ? "0" : (Number((num * 1_000_000n) / den) / 10_000).toFixed(digits));

export default function LiquidityPage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const now = useNow(10_000);
  const shareHistory = useShareHistory();
  const epochs = useService<Epoch[]>(config ? `${config.services.treasury}/epochs` : undefined, 30_000);
  const treasury = useService<TreasuryHealth>(config ? `${config.services.treasury}/health` : undefined, 30_000);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [deposit, setDeposit] = useState("1000");
  const [redeem, setRedeem] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!ledger) return <div className="card muted">Reading the pool…</div>;

  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;
  const zlp = ledger.lpSupply > 0n ? balanceOf(w.shieldedBalances, hex(ledger.lpToken)) : 0n;
  const value = (shares: bigint) => (ledger.lpSupply > 0n ? (shares * ledger.poolValue) / ledger.lpSupply : 0n);
  const sharesFor = (amount: bigint) => (ledger.lpSupply === 0n ? amount : (amount * ledger.lpSupply) / ledger.poolValue);
  const sharePrice = ledger.lpSupply > 0n ? (ledger.poolValue * ONE) / ledger.lpSupply : ONE;
  const reserved = reservedOf(ledger);
  // Only what is not reserved for open positions can leave: the pool must keep
  // more than the reserve (`repool`'s capacity check).
  const poolWithdrawable = ledger.poolValue - reserved - (reserved > 0n ? 1n : 0n);
  const yours = value(zlp);
  const yourWithdrawable = yours < poolWithdrawable ? yours : poolWithdrawable > 0n ? poolWithdrawable : 0n;
  // The most shares that redeem within what the pool can release.
  const maxRedeem = yours <= poolWithdrawable ? zlp : ledger.poolValue > 0n ? (poolWithdrawable * ledger.lpSupply) / ledger.poolValue : 0n;
  const slotsUsed = Number(ledger.slotCapacity - ledger.freeSlots);
  const slots = Number(ledger.slotCapacity);
  // The first deposit mints one share per unit, so a share started at 1.000000.
  const sinceLaunch = sharePrice - ONE;

  const paid = (epochs ?? []).reduce((sum, e) => sum + BigInt(e.deposited), 0n);
  const last = epochs && epochs.length ? epochs[epochs.length - 1] : null;
  const closesLeft = treasury ? Math.max(0, treasury.rules.minCloses - treasury.closesSinceLastEpoch) : null;
  const secondsLeft =
    treasury && treasury.secondsSinceLastEpoch !== null ? Math.max(0, treasury.rules.minSeconds - treasury.secondsSinceLastEpoch) : null;

  const depositAmount = parse6(deposit);
  const redeemShares = parse6(redeem);
  const depositShares = depositAmount ? sharesFor(depositAmount) : 0n;
  const depositProblem = !depositAmount
    ? "Enter an amount."
    : depositAmount > pusdc
      ? `Your wallet holds ${fmt6(pusdc)} pUSDC.`
      : depositShares === 0n
        ? "Too small to mint a share."
        : null;
  const redeemProblem = !redeemShares
    ? "Enter the zLP to redeem."
    : redeemShares > zlp
      ? `You hold ${fmt6(zlp)} zLP.`
      : redeemShares > maxRedeem
        ? `Only ${fmt6(maxRedeem)} zLP can redeem now: the rest of the pool is reserved for open positions.`
        : null;

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

  const quick = (max: bigint, set: (v: string) => void) =>
    max > 0n && (
      <span className="quick">
        {[25n, 50n, 75n, 100n].map((p) => (
          <button key={String(p)} type="button" className="small" onClick={() => set(fmt6((max * p) / 100n, 6).replace(/,/g, ""))}>
            {p === 100n ? "Max" : `${p}%`}
          </button>
        ))}
      </span>
    );

  return (
    <>
      <p className="eyebrow">Liquidity pool</p>
      <h1>
        Earn fees. <span className="soft">Be the traders' counterparty.</span>
      </h1>
      <p className="lead">
        The pool pays traders' profits and keeps their losses, and receives {treasury?.rules.lpSharePct ?? 70}% of trading
        fees in batches. You hold zLP, a shielded share of it: what you hold is private.
      </p>

      <ProverSetup />

      <section className="stats">
        <Stat label="Pool value" value={fmt6(ledger.poolValue, 0)} unit="pUSDC" sub={`${fmt6(ledger.lpSupply, 0)} zLP in issue`} />
        <Stat
          label="zLP share price"
          value={fmt6(sharePrice, 6)}
          unit="pUSDC"
          sub={
            <span className={sinceLaunch >= 0n ? "good" : "bad"}>
              {sinceLaunch >= 0n ? "+" : "−"}
              {pctOf(sinceLaunch >= 0n ? sinceLaunch : -sinceLaunch, ONE, 3)}% since launch, all PnL and fees in
            </span>
          }
        />
        <Stat
          label="Reserved for positions"
          value={fmt6(reserved, 0)}
          unit="pUSDC"
          sub={`${slotsUsed} of ${slots} slots × ${fmt6(ledger.maxPayout, 0)} worst-case payout`}
          meter={{ value: slots ? slotsUsed / slots : 0, tone: slots && slotsUsed / slots > 0.8 ? "warn" : undefined }}
        />
        <Stat
          label="Pool withdrawable now"
          value={fmt6(poolWithdrawable > 0n ? poolWithdrawable : 0n, 0)}
          unit="pUSDC"
          sub="everything not reserved, across all LPs"
        />
      </section>

      <div className="grid-main">
        <div>
          <section className="card">
            <div className="card-head">
              <h2>
                zLP share price <small className="muted">after each pool change, on chain</small>
              </h2>
            </div>
            <PriceChart
              points={shareHistory}
              now={now}
              format={(v) => `${fmt6(v, 6)} pUSDC`}
              axisDecimals={6}
              noun="after a change at"
              emptyText="No pool changes yet."
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Fee epochs</h2>
              {!epochs && <span className="chip warn">treasury unreachable</span>}
            </div>
            <div className="market-head">
              <div className="kv">
                <span>Paid to LPs</span>
                <b>{epochs ? `${fmt6(paid)} pUSDC` : "—"}</b>
              </div>
              <div className="kv">
                <span>Epochs</span>
                <b>{epochs ? epochs.length : "—"}</b>
              </div>
              <div className="kv">
                <span>Last epoch</span>
                <b>{last ? new Date(last.at).toLocaleString() : "none yet"}</b>
              </div>
              {treasury && (
                <div className="kv" title="An epoch needs both, so a deposit never reveals one trade's fees">
                  <span>Next epoch</span>
                  <b>
                    {closesLeft === 0 && !secondsLeft
                      ? "due now"
                      : [closesLeft ? `${closesLeft} more close${closesLeft === 1 ? "" : "s"}` : null, secondsLeft ? `${Math.ceil(secondsLeft / 60)} min` : null]
                          .filter(Boolean)
                          .join(" and ")}
                  </b>
                </div>
              )}
            </div>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.6 }}>
              Fees collect in the treasury and reach the pool only after at least {treasury?.rules.minCloses ?? 5} closes and{" "}
              {Math.round((treasury?.rules.minSeconds ?? 3600) / 60)} minutes, so no deposit reveals one trade's fees, and with
              them its size. For the same reason, fees collected so far are not shown.
            </p>
            {epochs && epochs.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Closes so far</th>
                      <th>Paid to LPs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {epochs
                      .slice()
                      .reverse()
                      .map((e) => (
                        <tr key={e.txHash}>
                          <td className="text">{new Date(e.at).toLocaleString()}</td>
                          <td>{e.closedPositions}</td>
                          <td>{fmt6(BigInt(e.deposited))} pUSDC</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <details className="card inspector">
            <summary>
              <h2>How LP returns work</h2>
              <span className="muted">and what can go wrong</span>
            </summary>
            <div className="inspect">
              <div>
                <b>Shares</b>
                <p>
                  A deposit mints zLP at the current share price; a withdrawal redeems it at the share price then. Rounding is
                  always in the pool's favour, by at most one unit.
                </p>
              </div>
              <div>
                <b>Trader PnL</b>
                <p>
                  A trader's loss enters the pool at close; a profit leaves it. Your return is fees plus what traders lose,
                  minus what they win. The share price above includes all of it.
                </p>
              </div>
              <div>
                <b>Worst case per position</b>
                <p>
                  Profit is capped at {fmt6(ledger.maxPayout, 0)} pUSDC per position, and each open position reserves that
                  much. So the pool can never owe more than it holds, and one position can cost it at most the cap.
                </p>
              </div>
              <div>
                <b>Reserved liquidity</b>
                <p>
                  Reserved pUSDC cannot be withdrawn until positions close. It is the worst case, not a loss: most positions
                  pay out far less than the cap.
                </p>
              </div>
              <div>
                <b>Capacity</b>
                <p>
                  The pool holds {slots} positions at most: one slot per {fmt6(ledger.maxPayout, 0)} pUSDC of liquidity.
                  Deposits add slots; withdrawals remove free ones.
                </p>
              </div>
              <div>
                <b>Privacy</b>
                <p>
                  Each deposit and withdrawal changes the public pool, so its amount is visible, but not whose it was: zLP
                  is a shielded token in your wallet.
                </p>
              </div>
            </div>
          </details>
        </div>

        <div className="sticky">
          <section className="card">
            <div className="card-head">
              <h2>Your liquidity</h2>
              <span className="chip accent">shielded</span>
            </div>
            {w.api ? (
              <dl className="summary">
                <dt>zLP held</dt>
                <dd className="strong">{fmt6(zlp, 6)}</dd>
                <dt>Worth</dt>
                <dd>{fmt6(yours)} pUSDC</dd>
                <dt>Share of pool</dt>
                <dd>{pctOf(zlp, ledger.lpSupply, 4)}%</dd>
                <dt title="The smaller of what your zLP is worth and what the pool can release now">You can withdraw now</dt>
                <dd>{fmt6(yourWithdrawable)} pUSDC</dd>
              </dl>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
                Connect a wallet to deposit pUSDC or redeem zLP. Your zLP stays shielded in your wallet.
              </p>
            )}
          </section>

          {w.api && (
            <section className="card trade">
              <div className="toggle">
                <button className={tab === "deposit" ? "on long" : ""} onClick={() => setTab("deposit")}>
                  Deposit
                </button>
                <button className={tab === "withdraw" ? "on short" : ""} onClick={() => setTab("withdraw")}>
                  Withdraw
                </button>
              </div>
              {tab === "deposit" ? (
                <>
                  <label>
                    <span className="label-row">
                      Amount <small>wallet {fmt6(pusdc)} pUSDC</small>
                    </span>
                    <span className="input-unit">
                      <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
                      <span>pUSDC</span>
                    </span>
                    {quick(pusdc, setDeposit)}
                  </label>
                  <dl className="summary">
                    <dt>Share price</dt>
                    <dd>{fmt6(sharePrice, 6)} pUSDC</dd>
                    <dt>You receive</dt>
                    <dd className="strong">{fmt6(depositShares, 6)} zLP</dd>
                    <dt>Your share after</dt>
                    <dd>{pctOf(zlp + depositShares, ledger.lpSupply + depositShares, 4)}%</dd>
                    <dt>Slots this adds</dt>
                    <dd>{depositAmount ? String((ledger.poolValue + depositAmount - 1n) / ledger.maxPayout - ledger.slotCapacity) : "0"}</dd>
                  </dl>
                  <button
                    className="primary"
                    disabled={busy || !!depositProblem}
                    onClick={() => depositAmount && run("Deposit", async () => addLiquidity(await w.contract("zkperp"), depositAmount))}
                  >
                    Deposit {depositAmount ? fmt6(depositAmount) : ""} pUSDC
                  </button>
                  {depositProblem && deposit && <p className="muted" style={{ margin: 0 }}>{depositProblem}</p>}
                </>
              ) : (
                <>
                  <label>
                    <span className="label-row">
                      zLP to redeem <small>you hold {fmt6(zlp, 6)}</small>
                    </span>
                    <span className="input-unit">
                      <input placeholder="0" value={redeem} onChange={(e) => setRedeem(e.target.value)} inputMode="decimal" />
                      <span>zLP</span>
                    </span>
                    {quick(maxRedeem, setRedeem)}
                  </label>
                  <dl className="summary">
                    <dt>Share price</dt>
                    <dd>{fmt6(sharePrice, 6)} pUSDC</dd>
                    <dt>You receive</dt>
                    <dd className="strong">{fmt6(redeemShares ? value(redeemShares) : 0n)} pUSDC</dd>
                    <dt>Redeemable now</dt>
                    <dd>{fmt6(maxRedeem, 6)} zLP</dd>
                  </dl>
                  <button
                    className="primary"
                    disabled={busy || !!redeemProblem}
                    onClick={() =>
                      redeemShares && run("Withdraw", async () => (await removeLiquidity(await w.contract("zkperp"), redeemShares)).txHash)
                    }
                  >
                    Redeem zLP
                  </button>
                  {redeemProblem && redeem && <p className="muted" style={{ margin: 0 }}>{redeemProblem}</p>}
                </>
              )}
              {status && <p className={/failed/.test(status) ? "bad" : "muted"} style={{ margin: 0 }}>{status}</p>}
              <ProverLine />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
