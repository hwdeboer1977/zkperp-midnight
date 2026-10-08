// SPDX-License-Identifier: Apache-2.0

import { reservedOf } from "@core/math";
import { fmt6 } from "../lib/bytes";
import { useActivity, useConfig, useLedger, useNow, useService } from "../lib/hooks";
import { ActivityFeed, PriceChart, Stat } from "../components/Market";

interface Epoch {
  at: string;
  closedPositions: string;
  deposited: string;
  txHash: string;
}

export default function PublicPage() {
  const config = useConfig();
  const { ledger, error } = useLedger();
  const now = useNow(5000);
  const relayer = useService<any>(config ? `${config.services.relayer}/health` : undefined);
  const epochs = useService<Epoch[]>(config ? `${config.services.treasury}/epochs` : undefined, 30_000);
  const { actions, prices } = useActivity();

  if (error) return <div className="card bad">{error}</div>;
  if (!ledger) return <div className="card muted">Reading zkperp…</div>;

  const live = ledger.openPositions - ledger.closedPositions;
  const reserved = reservedOf(ledger);
  const share = ledger.lpSupply > 0n ? (ledger.poolValue * 1_000_000n) / ledger.lpSupply : 1_000_000n;
  const age = now - Number(ledger.priceTime);
  const maxAge = Number(ledger.maxPriceAge);
  const slotsUsed = Number(ledger.slotCapacity - ledger.freeSlots);
  const slots = Number(ledger.slotCapacity);
  const liquidations = actions?.filter((a) => a.entryPoint === "liquidatePosition").length;

  return (
    <>
      <p className="eyebrow">Public ledger</p>
      <h1>
        Public by design. <span className="soft">Private by default.</span>
      </h1>
      <p className="lead">
        Everything on this page is read from the Midnight ledger, and anyone can check it. What it never shows — a position's
        size, collateral, direction or owner — is the point of zkperp.
      </p>

      <section className="stats">
        <Stat
          label="Pool liquidity"
          value={fmt6(ledger.poolValue, 0)}
          unit="pUSDC"
          sub={`${fmt6(ledger.lpSupply, 0)} zLP · ${fmt6(share, 4)} pUSDC per zLP`}
        />
        <Stat
          label="Reserved for positions"
          value={fmt6(reserved, 0)}
          unit="pUSDC"
          sub={`${slotsUsed} of ${slots} slots of ${fmt6(ledger.maxPayout, 0)} in use`}
          meter={{ value: slots ? slotsUsed / slots : 0, tone: slots && slotsUsed / slots > 0.8 ? "warn" : undefined }}
        />
        <Stat
          label="Open positions"
          value={String(live)}
          sub={`${ledger.openPositions} opened · ${ledger.closedPositions} closed${liquidations !== undefined ? ` · ${liquidations} liquidated` : ""}`}
        />
        <Stat
          label="Mark price · ETH-USD"
          value={`$${fmt6(ledger.markPrice)}`}
          sub={`${Math.floor(age / 60)} of ${Math.floor(maxAge / 60)} min max age${relayer ? ` · relayer ${relayer.lastError ? "erroring" : "up"}` : " · relayer unreachable"}`}
          meter={{ value: age / maxAge, tone: age >= maxAge ? "bad" : age > maxAge * 0.75 ? "warn" : undefined }}
        />
      </section>

      <section className="grid-main">
        <div className="card">
          <div className="card-head">
            <h2>
              Mark price <small className="muted">as set on chain</small>
            </h2>
            <span className="chip plain">last {prices?.length ?? "…"} updates</span>
          </div>
          <PriceChart points={prices} now={now} />
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Activity</h2>
            <span className="chip accent">live from the indexer</span>
          </div>
          <ActivityFeed actions={actions} now={now} limit={7} />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>How a private trade moves</h2>
          <span className="muted">what each party sees</span>
        </div>
        <div className="flow">
          <div className="step private">
            <div className="who">
              <i>◆</i> Trader
            </div>
            <div className="where">in the browser, unlocked with a password</div>
            <ul>
              <li>Size, side, collateral</li>
              <li>Owner secret and salt</li>
              <li>Encrypted note for recovery</li>
            </ul>
          </div>
          <div className="arrow">→</div>
          <div className="step proof">
            <div className="who">
              <i>∎</i> Zero-knowledge proof
            </div>
            <div className="where">made by a proof server on the trader's machine</div>
            <ul>
              <li>The trade follows the rules</li>
              <li>Margin, fees and caps hold</li>
              <li>Reveals none of the inputs</li>
            </ul>
          </div>
          <div className="arrow">→</div>
          <div className="step">
            <div className="who">
              <i>▦</i> Midnight ledger
            </div>
            <div className="where">public to everyone</div>
            <ul>
              <li>A commitment at open</li>
              <li>A nullifier at close</li>
              <li>The pool's change: the PnL</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="split">
        <div className="pub">
          <h2>
            <span className="chip plain">Public</span> anyone can read
          </h2>
          <ul>
            <li>Pool liquidity and zLP supply, so every LP deposit and withdrawal</li>
            <li>Reserved liquidity: open positions × the payout cap ({fmt6(ledger.maxPayout, 0)} pUSDC)</li>
            <li>The mark price and when the oracle saw it</li>
            <li>That a position opened, closed or was liquidated, and when</li>
            <li>At a close, the PnL — it is the pool's change</li>
            <li>Each fee epoch's deposit to LPs</li>
          </ul>
        </div>
        <div className="priv">
          <h2>
            <span className="chip accent">Private</span> hidden from the public
          </h2>
          <ul>
            <li>A position's size, collateral and leverage</li>
            <li>Its direction, at open — longs and shorts look alike</li>
            <li>Who owns it: a hash of a secret, not a wallet</li>
            <li>Which open a close belongs to</li>
            <li>Every individual fee (the treasury sees them)</li>
            <li>Who receives a payout</li>
          </ul>
          <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
            The keeper can read open positions, so it can liquidate them; the treasury sees fees. See docs/privacy.md.
          </p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Fee epochs</h2>
          {!epochs && <span className="chip warn">treasury unreachable</span>}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Fees go to the treasury, which pays the LPs' 70% into the pool once at least 5 positions have closed and an hour
          has passed — so a deposit never reveals one trade's fees, and with them its size.
        </p>
        {epochs && epochs.length === 0 && <p className="muted">No epochs yet.</p>}
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
                      <td>{new Date(e.at).toLocaleString()}</td>
                      <td>{e.closedPositions}</td>
                      <td>{fmt6(BigInt(e.deposited))} pUSDC</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
