// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { proverLabel, useWallet } from "../lib/wallet";

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);

  if (w.api) {
    return (
      <div className="wallet">
        <span
          className={`pill ${w.proverIsLocal ? "ok" : "bad"}`}
          title={
            (w.canProve ? "Your wallet sends each trade to the proof server in its settings: " : "Each trade is proven on: ") +
            `${w.prover}. Whoever runs it sees the trade's size, direction and collateral.`
          }
        >
          {w.name} · prover {proverLabel(w.prover)}
          {!w.proverIsLocal && " — not on this machine, it sees your positions"}
        </span>
        <button className="ghost" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button onClick={() => setOpen(!open)} disabled={w.connecting}>
        {w.connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="menu">
          {w.detected.length === 0 && <p>No Midnight wallet found. Install 1AM (recommended) or Lace.</p>}
          {w.detected.map((d) => (
            <button
              key={d.key}
              onClick={() => {
                setOpen(false);
                void w.connect(d);
              }}
            >
              {d.api.icon && <img src={d.api.icon} alt="" />} {d.api.name ?? d.key}
            </button>
          ))}
        </div>
      )}
      {w.error && <div className="menu error">{w.error}</div>}
    </div>
  );
}

/** Shown in place of a page's actions until a wallet is connected. */
export function NeedsWallet({ what }: { what: string }) {
  return (
    <div className="card muted">
      Connect a wallet to {what}. Every trade is proven by a proof server, which sees its size, direction and collateral:
      1AM uses the one in its own network settings, Lace the one on this machine. Use a proof server on your own machine.
      The wallet button shows which one is in use.
    </div>
  );
}
