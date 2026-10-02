// SPDX-License-Identifier: Apache-2.0

import { reservedOf } from "@core/math";
import { fmt6 } from "../lib/bytes";
import { useConfig, useLedger, useNow, useService } from "../lib/hooks";

interface Epoch {
  at: string;
  closedPositions: string;
  deposited: string;
  txHash: string;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export default function PublicPage() {
  const config = useConfig();
  const { ledger, error } = useLedger();
  const now = useNow(5000);
  const relayer = useService<any>(config ? `${config.services.relayer}/health` : undefined);
  const epochs = useService<Epoch[]>(config ? `${config.services.treasury}/epochs` : undefined, 30_000);

  if (error) return <div className="card bad">{error}</div>;
  if (!ledger) return <div className="card muted">Reading zkperp…</div>;

  const live = ledger.openPositions - ledger.closedPositions;
  const reserved = reservedOf(ledger);
  const share = ledger.lpSupply > 0n ? (ledger.poolValue * 1_000_000n) / ledger.lpSupply : 1_000_000n;
  const age = now - Number(ledger.priceTime);

  return (
    <>
      <h1>What the chain shows</h1>
      <p className="lead">
        Everything on this page is public: anyone can read it from the ledger. What it does not show — any position's size,
        collateral, direction or owner — is the point of zkperp.
      </p>

      <section className="stats">
        <Stat label="Pool" value={`${fmt6(ledger.poolValue, 0)} pUSDC`} sub={`${fmt6(ledger.lpSupply, 0)} zLP · ${fmt6(share, 4)} pUSDC per zLP`} />
        <Stat
          label="Reserved for open positions"
          value={`${fmt6(reserved, 0)} pUSDC`}
          sub={`${ledger.slotCapacity - ledger.freeSlots} of ${ledger.slotCapacity} slots of ${fmt6(ledger.maxPayout, 0)}`}
        />
        <Stat label="Open positions" value={String(live)} sub={`${ledger.openPositions} opened · ${ledger.closedPositions} closed`} />
        <Stat
          label="Mark price"
          value={`$${fmt6(ledger.markPrice)}`}
          sub={`${Math.floor(age / 60)} min old · limit ${Math.floor(Number(ledger.maxPriceAge) / 60)} min${relayer ? ` · relayer ${relayer.lastError ? "erroring" : "up"}` : " · relayer unreachable"}`}
        />
      </section>

      <section className="two">
        <div className="card">
          <h2>Public</h2>
          <ul>
            <li>Pool liquidity and zLP supply, so every LP deposit and withdrawal</li>
            <li>Reserved liquidity: open positions × the payout cap ({fmt6(ledger.maxPayout, 0)} pUSDC)</li>
            <li>The mark price and when the oracle saw it</li>
            <li>That a position opened or closed, and when</li>
            <li>At a close, the PnL — it is the pool's change</li>
            <li>Each fee epoch's deposit to LPs</li>
          </ul>
        </div>
        <div className="card">
          <h2>Private</h2>
          <ul>
            <li>A position's size, collateral and leverage</li>
            <li>Its direction, at open — longs and shorts look alike</li>
            <li>Who owns it: a hash of a secret, not a wallet</li>
            <li>Which open a close belongs to</li>
            <li>Every individual fee (the treasury sees them)</li>
            <li>Who receives a payout</li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h2>Fee epochs</h2>
        <p className="muted">
          Fees go to the treasury, which pays the LPs' 70% into the pool once at least 5 positions have closed and an hour
          has passed — so a deposit never reveals one trade's fees, and with them its size.
        </p>
        {!epochs && <p className="muted">The treasury service is not reachable.</p>}
        {epochs && epochs.length === 0 && <p className="muted">No epochs yet.</p>}
        {epochs && epochs.length > 0 && (
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
        )}
      </section>
    </>
  );
}
