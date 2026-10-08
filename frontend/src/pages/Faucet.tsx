// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmt6, parse6 } from "../lib/bytes";
import { useConfig, useLedger } from "../lib/hooks";
import { mintPusdc } from "../lib/trading";
import { balanceOf, useWallet } from "../lib/wallet";
import { ProverLine, ProverSetup } from "../components/ProverSetup";
import { TxProgress, useTxProgress } from "../components/TxProgress";

const PRESETS = ["1000", "5000", "10000"];
const PREVIEW_NIGHT_FAUCET = "https://midnight-tmnight-preview.nethermind.dev/";

const networkName = (id: string) => (id === "preview" ? "Midnight Preview" : id === "undeployed" ? "Local devnet" : id);

export default function FaucetPage() {
  const w = useWallet();
  const config = useConfig();
  const { ledger: pusdcLedger } = useLedger("pusdc", 15_000);
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ amount: bigint; txHash: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const progress = useTxProgress();

  useEffect(() => {
    setAddress(null);
    void (w.api as any)?.getUnshieldedAddress?.().then(
      (a: any) => setAddress(String(a?.unshieldedAddress ?? a)),
      () => {}
    );
  }, [w.api]);

  const value = parse6(amount);
  const pusdc = config ? balanceOf(w.shieldedBalances, config.usdcToken) : 0n;
  const network = config?.network.networkId ?? "";
  const noDust = w.api && w.dust !== null && w.dust === 0n;
  const problem = !w.api ? "Connect a wallet to mint." : noDust ? "Your wallet has no DUST to pay the fee yet." : !value ? "Enter an amount." : null;

  async function mint() {
    if (!value) return;
    setBusy(true);
    setMinted(null);
    setFailure(null);
    progress.start();
    try {
      const txHash = await mintPusdc(await w.contract("pusdc"), value);
      progress.done();
      setMinted({ amount: value, txHash });
      void w.refresh();
    } catch (e: any) {
      progress.fail();
      setFailure(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="eyebrow">Test tokens</p>
      <h1>
        Get test pUSDC <span className="soft">to start trading.</span>
      </h1>
      <p className="lead">
        pUSDC is a mock stablecoin for testing, with <b>no monetary value</b>: anyone can mint any amount. Your balance is
        shielded.
      </p>

      <ProverSetup />

      <div className="grid-main">
        <div>
          <section className="card trade">
            <label>
              <span className="label-row">
                Amount to mint {w.api && <small>wallet {fmt6(pusdc)} pUSDC</small>}
              </span>
              <span className="input-unit">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                <span>pUSDC</span>
              </span>
              <span className="quick" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                {PRESETS.map((p) => (
                  <button key={p} type="button" className={`small ${amount === p ? "on" : ""}`} onClick={() => setAmount(p)}>
                    {Number(p).toLocaleString("en-US")}
                  </button>
                ))}
              </span>
            </label>

            <dl className="summary">
              <dt>Token</dt>
              <dd>pUSDC · test only</dd>
              <dt title="Your balance is private; the minted amount is public, as the total supply rises by it">Balance</dt>
              <dd>shielded</dd>
              <dt>Network</dt>
              <dd>{networkName(network)}</dd>
              <dt>Fee</dt>
              <dd>a little DUST, paid by your wallet</dd>
              {pusdcLedger && (
                <>
                  <dt title="Public: every mint raises it by its amount">Total minted, all wallets</dt>
                  <dd>{fmt6(pusdcLedger.totalSupply, 0)}</dd>
                </>
              )}
            </dl>

            {w.api && (
              <ul className="checks">
                <li className="ok">Wallet connected{w.name ? ` · ${w.name}` : ""}</li>
                {w.dust === null ? (
                  <li>DUST balance unknown: your wallet did not report it</li>
                ) : w.dust > 0n ? (
                  <li className="ok">DUST available for the fee</li>
                ) : (
                  <li className="bad">
                    No DUST yet.{" "}
                    {network === "preview" ? (
                      <>
                        Get tNIGHT at the{" "}
                        <a href={PREVIEW_NIGHT_FAUCET} target="_blank" rel="noreferrer">
                          Preview faucet
                        </a>
                        , then register it for DUST generation in your wallet. DUST accrues over a few minutes.
                      </>
                    ) : (
                      <>
                        Fund the wallet with <code>npm run fund -- {address ?? "<your unshielded address>"}</code>, then register
                        the NIGHT for DUST generation in your wallet.
                      </>
                    )}
                  </li>
                )}
              </ul>
            )}

            <button className="primary" disabled={busy || !!problem} onClick={mint}>
              {busy ? "Minting…" : `Mint ${value ? fmt6(value, 0) : ""} pUSDC`}
            </button>
            {problem && !w.api && <p className="muted" style={{ margin: 0 }}>{problem}</p>}
            <TxProgress progress={progress} prepare="Prepare the mint" />
            <ProverLine />
            {failure && <p className="bad" style={{ margin: 0 }}>Mint failed: {failure}</p>}
            {minted && (
              <div className="banner ok" style={{ margin: 0 }}>
                Minted {fmt6(minted.amount)} pUSDC ({minted.txHash.slice(0, 12)}…). Your wallet shows it within a few seconds:{" "}
                <b>{fmt6(pusdc)} pUSDC</b> now. <Link to="/trade">Trade →</Link>
              </div>
            )}
          </section>
        </div>

        <div>
          <details className="card inspector">
            <summary>
              <h2>Setup &amp; troubleshooting</h2>
            </summary>
            <div className="setup">
              <h3>1. Wallet</h3>
              <p>
                Install 1AM (or Lace) and set it to the <b>{networkName(network)}</b> network. A wallet on another network is
                refused when you connect.
              </p>
              <h3>2. NIGHT, then DUST</h3>
              {network === "preview" ? (
                <p>
                  Get tNIGHT at the{" "}
                  <a href={PREVIEW_NIGHT_FAUCET} target="_blank" rel="noreferrer">
                    Preview faucet
                  </a>{" "}
                  for your wallet's unshielded address, then register it for DUST generation in the wallet. Fees are paid in
                  DUST, which grows with the NIGHT you hold.
                </p>
              ) : (
                <p>
                  Send NIGHT from the devnet's dev wallet with <code>npm run fund -- {address ?? "<address>"}</code>, then
                  register it for DUST generation in the wallet. With only a few NIGHT, DUST takes many minutes to cover even
                  the registration.
                </p>
              )}
              {address && (
                <p className="muted mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                  Your unshielded address: {address}
                </p>
              )}
              <h3>3. Mint, then trade</h3>
              <p>Mint pUSDC here, unlock your position key on the Trade page with a password, and open a position.</p>
              <h3>If a mint fails</h3>
              <ul>
                <li>"No DUST" or a fee error: wait for DUST to accrue after registering NIGHT.</li>
                <li>"check failed (400): bad input": restart the dev server after reconfiguring the frontend.</li>
                <li>Error 171 right after restarting a devnet: wait for fresh blocks, then try again.</li>
                <li>The wallet asks nothing and nothing happens: unlock the wallet extension and reconnect.</li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
