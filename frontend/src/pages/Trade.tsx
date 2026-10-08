// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { circuitNow, closeFeeOf, liquidationPrice, openFeeOf, positionPnl } from "@core/math";
import { fmt6, parse6 } from "../lib/bytes";
import { useConfig, useLedger, useNow, useService } from "../lib/hooks";
import { INTERVALS, useCandles, useLivePrice } from "../lib/market";
import { PriceMovedError, openPosition } from "../lib/trading";
import { usePositionKey } from "../lib/positionKey";
import { usePositions } from "../lib/usePositions";
import { balanceOf, proverLabel, useWallet } from "../lib/wallet";
import { CandleChart } from "../components/CandleChart";
import { TxProgress, useTxProgress } from "../components/TxProgress";
import { PositionKeyPanel } from "../components/PositionKey";
import { ProverLine, ProverSetup, WhyDocker } from "../components/ProverSetup";
import { NeedsWallet } from "../components/WalletButton";
import { OpenRow } from "./Portfolio";

/**
 * The largest size `coin` can carry at `leverage`, after the opening fee:
 * size ≤ leverage × (coin − fee(size)), the contract's own bound.
 */
function sizeFor(coin: bigint, leverage: bigint, feeBps: bigint): bigint {
  let size = (coin * leverage * 10_000n) / (10_000n + leverage * feeBps);
  while (size > 0n && size > leverage * (coin - openFeeOf(size, feeBps))) size -= 1n;
  return size;
}

/** A proof plus the wallet's part takes about this long; a price closer than this to its limit may expire on the way. */
const TRADE_SECONDS = 120;
/** Above this gap between the live market and the execution price, warn: Chainlink itself updates at 0.5%. */
const DEVIATION_WARN = 1;

export default function TradePage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger } = useLedger();
  const now = useNow(1000);
  const [interval, setInterval_] = useState<number>(900);
  const live = useLivePrice();
  const { candles, error: marketError } = useCandles(interval, live);
  const key = usePositionKey();
  const positions = usePositions();
  const relayer = useService<any>(config ? `${config.services.relayer}/health` : undefined, 15_000);
  const [isLong, setLong] = useState(true);
  const [coinText, setCoin] = useState("1000");
  const [leverage, setLeverage] = useState(5);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const progress = useTxProgress();
  const [failure, setFailure] = useState<string | null>(null);
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
    const t = circuitNow();
    const liq =
      size > 0n
        ? liquidationPrice({ isLong, size, collateral: net, entryPrice: ledger.markPrice, openTime: t }, ledger, t)
        : 0n;
    const liqMove = liq > 0n ? (Math.abs(Number(ledger.markPrice - liq)) / Number(ledger.markPrice)) * 100 : 0;
    return { size, fee, net, capMove, liq, liqMove, closeFee: closeFeeOf(size, BigInt(ledger.closeFeeBps)) };
  }, [ledger, coin, leverage, isLong]);

  const maxLeverage = ledger ? Number(ledger.maxLeverage) : 20;
  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;
  const age = ledger ? now - Number(ledger.priceTime) : 0;
  const maxAge = ledger ? Number(ledger.maxPriceAge) : 0;
  const stale = !!ledger && age >= maxAge;
  const nearStale = !!ledger && !stale && maxAge - age < TRADE_SECONDS;
  const problem = !ledger
    ? "Reading zkperp…"
    : stale
      ? "Trading is paused until the oracle publishes a fresh price."
      : !coin || !plan
        ? "Enter the collateral to post."
        : plan.net < ledger.minCollateral
          ? `Collateral after the fee must be at least ${fmt6(ledger.minCollateral)} pUSDC.`
          : coin > pusdc
            ? `Your wallet holds ${fmt6(pusdc)} pUSDC. Get more from the faucet.`
            : ledger.freeSlots < 1n
              ? "The pool has no room for another position right now."
              : null;

  // The relayer's latest Chainlink round, when it differs from the price on chain.
  const nextRound: string | null = relayer?.lastRound?.price && relayer.lastRound.price !== relayer?.contractPrice?.price ? relayer.lastRound.price : null;

  const oracle = ledger ? Number(ledger.markPrice) / 1e6 : null;
  const market = live ?? (candles && candles.length ? candles[candles.length - 1].close : null);
  const deviation = market !== null && oracle !== null ? ((oracle - market) / market) * 100 : null;
  const deviates = deviation !== null && Math.abs(deviation) >= DEVIATION_WARN;
  const first = candles && candles.length ? candles[0].open : null;
  const change = market !== null && first ? ((market - first) / first) * 100 : null;
  const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const unrealised =
    ledger && positions.open.length > 0
      ? positions.open.reduce((sum, r) => {
          const o = r.opening;
          const pnl = positionPnl(o.isLong, BigInt(o.size), BigInt(o.entryPrice), ledger.markPrice, ledger.maxPayout);
          return sum + (pnl.profit ? pnl.pnl : -pnl.pnl);
        }, 0n)
      : null;
  const atRisk = positions.open.reduce((sum, r) => sum + BigInt(r.opening.collateral), 0n);

  async function submit(expectedPrice: bigint) {
    if (!coin || !plan || !key) return;
    setBusy(true);
    setConfirming(false);
    setMoved(null);
    setOpened(null);
    setFailure(null);
    progress.start();
    try {
      const perp = await w.contract("zkperp");
      const { txHash } = await openPosition(perp, key, coin, plan.size, isLong, expectedPrice);
      progress.done();
      setOpened(txHash);
      void w.refresh();
      positions.reload();
    } catch (e: any) {
      progress.fail();
      if (e instanceof PriceMovedError) setMoved(e);
      else setFailure(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const side = isLong ? "long" : "short";
  const signed = (v: bigint) => `${v >= 0n ? "+" : "−"}${fmt6(v >= 0n ? v : -v)}`;

  return (
    <>
    <ProverSetup />
    <div className="grid-main">
      <div>
        <section className="card">
          <div className="market-head">
            <div className="pair">
              <span className="coin">Ξ</span>
              <span>
                ETH-USD
                <small className="tag-line">Perpetual</small>
              </span>
            </div>
            <div className="kv">
              <span>Live market {live === null && "· delayed"}</span>
              <div className="big">{market !== null ? usd(market) : "…"}</div>
            </div>
            {change !== null && (
              <div className="kv">
                <span>Change · chart</span>
                <b className={change >= 0 ? "good" : "bad"}>
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(2)}%
                </b>
              </div>
            )}
            <div className="kv" title="Every open and close executes at this price: the contract's mark price, set by the oracle relayer from Chainlink">
              <span>Execution price</span>
              <b className="accent-text">{ledger ? `$${fmt6(ledger.markPrice)}` : "…"}</b>
            </div>
            {deviation !== null && (
              <div className="kv" title="How far the execution price is from the live market">
                <span>Deviation</span>
                <b className={deviates ? "warn-text" : ""}>
                  {deviation >= 0 ? "+" : ""}
                  {deviation.toFixed(2)}%
                </b>
              </div>
            )}
            {ledger && (
              <div className="kv">
                <span>Oracle age</span>
                <b className={stale ? "bad" : nearStale ? "warn-text" : ""}>
                  {Math.floor(age / 60)}m {age % 60}s / {Math.floor(maxAge / 60)}m
                </b>
              </div>
            )}
          </div>
          <div className="chart-bar">
            <span className="intervals">
              {INTERVALS.map((i) => (
                <button key={i.seconds} className={`small ${interval === i.seconds ? "on" : ""}`} onClick={() => setInterval_(i.seconds)}>
                  {i.label}
                </button>
              ))}
            </span>
            {ledger && (
              <span className={`chip ${stale ? "bad" : nearStale ? "warn" : "good"}`}>
                {stale ? "Oracle stale · trading paused" : nearStale ? "Oracle price expiring" : "Oracle live"}
              </span>
            )}
            <span className="muted legend">
              <i className="swatch" /> execution price · candles: Coinbase ETH-USD
            </span>
          </div>
          {deviates && !stale && (
            <div className="banner warn">
              The execution price is {Math.abs(deviation!).toFixed(2)}% {deviation! < 0 ? "below" : "above"} the live market.
              Trades open and close at {ledger ? `$${fmt6(ledger.markPrice)}` : "the oracle price"}, not at{" "}
              {market !== null ? usd(market) : "the market"}.
              {nextRound ? ` Chainlink's latest round is ${nextRound}; the relayer has not submitted it yet.` : !relayer ? " The relayer is not reachable." : ""}
            </div>
          )}
          {marketError && <p className="muted" style={{ fontSize: 13 }}>Live market data unavailable: {marketError}</p>}
          <CandleChart candles={candles} oracle={oracle} />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Your private positions</h2>
            <span className="chip accent">encrypted on chain</span>
          </div>
          <div className="market-head" style={{ marginBottom: positions.open.length ? 8 : 0 }}>
            <div className="kv">
              <span>Positions</span>
              <b>{w.api ? positions.open.length : "—"}</b>
            </div>
            <div className="kv">
              <span>Collateral</span>
              <b>{w.api && positions.open.length ? `${fmt6(atRisk)} pUSDC` : "—"}</b>
            </div>
            <div className="kv">
              <span>Unrealised PnL</span>
              <b className={unrealised === null ? "" : unrealised >= 0n ? "good" : "bad"}>
                {unrealised === null ? "—" : `${signed(unrealised)} pUSDC`}
              </b>
            </div>
            <Link to="/portfolio" style={{ marginLeft: "auto", fontSize: 13 }}>
              History →
            </Link>
          </div>
          {!w.api ? (
            <p className="muted" style={{ margin: 0 }}>Connect a wallet to see your positions.</p>
          ) : positions.open.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {key ? "No open positions." : "Unlock your position key to find positions opened on other computers."}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Size</th>
                    <th>Collateral</th>
                    <th>Entry</th>
                    <th>PnL now</th>
                    <th>Fees to close</th>
                    <th>You receive</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.open.map((r) => (
                    <OpenRow key={r.commitment} record={r} ledger={ledger} onClosed={positions.reload} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <details className="card inspector">
          <summary>
            <h2>Privacy inspector</h2>
            <span className="muted">who sees what, at each step of this trade</span>
          </summary>
          <div className="inspect">
            <div>
              <b>In your browser</b>
              <p>Size, side, collateral, leverage, your owner secret and salt. The opening is sealed into a note only your position key opens.</p>
            </div>
            <div>
              <b>Proof server · {w.api ? proverLabel(w.prover) : "your machine"}</b>
              <p>
                Uses every private input to build the proof, so it must be yours.{" "}
                {w.api && (w.proverIsLocal ? <span className="good">It is on this machine.</span> : <span className="bad">It is not on this machine.</span>)}{" "}
                <WhyDocker label="How proving works" />
              </p>
            </div>
            <div>
              <b>Your wallet</b>
              <p>Adds the DUST fee and signs. Its fee proof holds no position data.</p>
            </div>
            <div>
              <b>Everyone, on chain</b>
              <p>A commitment and two encrypted notes; the pool's reserved liquidity rises by one slot. Longs and shorts look alike.</p>
            </div>
            <div>
              <b>The keeper</b>
              <p>Decrypts its note: size, side, collateral, entry and payout key — enough to liquidate, never the owner secret, so it cannot close for you.</p>
            </div>
            <div>
              <b>At close</b>
              <p>A nullifier no one can link to this open, and the pool's change, which is the PnL. The treasury sees the fee.</p>
            </div>
          </div>
        </details>
      </div>

      <div className="sticky">
        {!w.api && <NeedsWallet what="trade" />}
        {w.api && <PositionKeyPanel compact />}
        <section className="card trade">
          <div className="toggle">
            <button className={isLong ? "on long" : ""} onClick={() => (setLong(true), setConfirming(false))}>
              Long
            </button>
            <button className={!isLong ? "on short" : ""} onClick={() => (setLong(false), setConfirming(false))}>
              Short
            </button>
          </div>
          <label>
            <span className="label-row">
              Collateral {w.api && <small>wallet {fmt6(pusdc)} pUSDC</small>}
            </span>
            <span className="input-unit">
              <input value={coinText} onChange={(e) => (setCoin(e.target.value), setConfirming(false))} inputMode="decimal" />
              <span>pUSDC</span>
            </span>
            {w.api && pusdc > 0n && (
              <span className="quick">
                {[25n, 50n, 75n, 100n].map((pct) => (
                  <button
                    key={String(pct)}
                    type="button"
                    className="small"
                    onClick={() => (setCoin(fmt6((pusdc * pct) / 100n, 6).replace(/,/g, "")), setConfirming(false))}
                  >
                    {pct === 100n ? "Max" : `${pct}%`}
                  </button>
                ))}
              </span>
            )}
          </label>
          <label>
            <span className="label-row">
              Leverage <b>{leverage}×</b>
            </span>
            <input
              type="range"
              min={1}
              max={maxLeverage}
              value={leverage}
              onChange={(e) => (setLeverage(Number(e.target.value)), setConfirming(false))}
            />
            <span className="ticks">
              <span>1×</span>
              <span>{Math.round(maxLeverage / 2)}×</span>
              <span>{maxLeverage}×</span>
            </span>
          </label>

          {plan && ledger && plan.size > 0n && (
            <>
              <dl className="summary">
                <dt title="Collateral after the opening fee × leverage">Position size</dt>
                <dd className="strong">{fmt6(plan.size)} pUSDC</dd>
                <dt title="The contract's mark price: every open executes here, whatever the live market shows">Entry (execution price)</dt>
                <dd>${fmt6(ledger.markPrice)}</dd>
                <dt>Opening fee ({Number(ledger.openFeeBps) / 100}%)</dt>
                <dd>{fmt6(plan.fee)}</dd>
                <dt>Collateral after fee</dt>
                <dd>{fmt6(plan.net)}</dd>
                <dt>Closing fee</dt>
                <dd>{fmt6(plan.closeFee)} at close</dd>
                <dt>Borrow fee</dt>
                <dd>{fmt6((plan.size * BigInt(ledger.borrowRate) * 3600n) / 1_000_000_000_000n, 4)} / hour</dd>
              </dl>
              <dl className="summary risk">
                <dt title={`The keeper may liquidate once equity falls below ${Number(ledger.maintenanceBps) / 100}% of size; a ${Number(ledger.liquidationFeeBps) / 100}% liquidation fee comes out of what is left`}>
                  Liquidation price
                </dt>
                <dd className="strong liq">
                  ≈ ${fmt6(plan.liq)} <small>({isLong ? "−" : "+"}{plan.liqMove.toFixed(1)}%)</small>
                </dd>
                <dt>Max loss</dt>
                <dd title="Everything you post: the loss stops at your collateral, plus fees">{fmt6(coin ?? 0n)} pUSDC</dd>
                <dt title="Profit is capped per position, so the pool can always pay">Max profit</dt>
                <dd className="good">
                  {fmt6(ledger.maxPayout, 0)} pUSDC at a {plan.capMove.toFixed(1)}% move
                </dd>
              </dl>
            </>
          )}

          {nearStale && !busy && (
            <div className="warn">
              The oracle price expires in {Math.max(0, maxAge - age)}s. A trade takes about a minute to prove and land; it fails
              if the price expires first, and costs nothing but time.
            </div>
          )}

          {w.api && !confirming && !busy && (
            <button className={`primary ${side}`} disabled={!!problem || !key} onClick={() => setConfirming(true)}>
              {`Open ${side}${plan && plan.size > 0n ? ` · ${fmt6(plan.size, 0)} pUSDC` : ""}`}
            </button>
          )}
          {w.api && confirming && plan && ledger && (
            <div className="confirm">
              <p>
                Open a <b className={side}>{side}</b> of <b>{fmt6(plan.size)} pUSDC</b> at <b>${fmt6(ledger.markPrice)}</b>,
                posting <b>{fmt6(coin ?? 0n)} pUSDC</b>. If the price changes while proving, nothing opens and you are asked
                again.
                {deviates && market !== null && (
                  <span className="warn-text">
                    {" "}
                    This is {Math.abs(deviation!).toFixed(2)}% {deviation! < 0 ? "below" : "above"} the live market ({usd(market)}).
                  </span>
                )}
              </p>
              <div className="row" style={{ margin: 0 }}>
                <button className="ghost" onClick={() => setConfirming(false)}>
                  Back
                </button>
                <button className={`primary ${side}`} style={{ flex: 1 }} disabled={!!problem || !key} onClick={() => submit(ledger.markPrice)}>
                  Confirm and prove
                </button>
              </div>
            </div>
          )}
          {w.api && !key && <p className="muted" style={{ margin: 0 }}>Unlock your position key above to trade.</p>}
          {problem && w.api && <p className="muted" style={{ margin: 0 }}>{problem}</p>}
          <TxProgress progress={progress} prepare="Prepare the opening and its encrypted note" />
          <ProverLine />
          {failure && <p className="bad" style={{ margin: 0 }}>Failed: {failure}</p>}
          {moved && (
            <div className="banner warn">
              The price moved from ${fmt6(moved.provenAt)} to ${fmt6(moved.now)} while proving. Nothing was opened.{" "}
              <button onClick={() => submit(moved.now)}>Open at ${fmt6(moved.now)}</button>
            </div>
          )}
          {opened && (
            <div className="banner ok">
              Position opened ({opened.slice(0, 12)}…). Its opening is on chain, encrypted to your password: with the password
              and this wallet you can close it from any computer.
            </div>
          )}
        </section>
      </div>
    </div>
    </>
  );
}
