// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { proverLabel, useWallet } from "../lib/wallet";

const DOCKER =
  "docker run -d --name proof-server --restart unless-stopped -p 6300:6300 midnightntwrk/proof-server:8.1.0 midnight-proof-server -v";
const TIP_KEY = "zkperp:prover-tip-dismissed";

function tipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return false;
  }
}

/** "Read more": why a proof server, and why on your machine. */
export function WhyDocker({ label = "Why Docker? Read more" }: { label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="link" onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      {createPortal(
      <dialog
        ref={dialog}
        className="modal"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <div className="modal-body">
          <header>
            <h2>Why run a proof server on your machine?</h2>
            <button type="button" className="ghost small" onClick={() => dialog.current?.close()} aria-label="Close">
              ✕
            </button>
          </header>

          <h3>Every trade carries a proof</h3>
          <p>
            On Midnight, a transaction does not show its inputs. It carries a zero-knowledge proof that it follows
            zkperp's rules (enough collateral, the leverage limit, a correct payout) without revealing the inputs
            themselves. The chain checks the proof and learns nothing more.
          </p>

          <h3>Whoever makes the proof sees your trade</h3>
          <p>
            To compute the proof, the prover needs the private inputs: your position's size, direction, collateral and
            entry price. So the question is <b>where</b> the proof is made.
          </p>
          <table className="table compact">
            <thead>
              <tr>
                <th>Prover</th>
                <th>Who sees your position</th>
                <th>Speed (preview)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>Proof server in Docker</b>, on your machine
                </td>
                <td className="good">only you</td>
                <td>2–4 s a proof; ~11–17 s a trade with 1AM on Local</td>
              </tr>
              <tr>
                <td>1AM Proofstation (hosted)</td>
                <td className="bad">1AM's server</td>
                <td>~40 s a proof</td>
              </tr>
              <tr>
                <td>1AM in-browser (WASM)</td>
                <td className="good">only you</td>
                <td>slower; experimental, not yet tested with zkperp's larger circuits</td>
              </tr>
            </tbody>
          </table>

          <h3>What the proof server is</h3>
          <ul>
            <li>
              Midnight's own proof server (<code>midnightntwrk/proof-server</code>), packaged as a Docker image. Docker is
              just the easiest way to run it on Windows, macOS or Linux.
            </li>
            <li>
              It listens on <code>localhost:6300</code>, on your machine only. This page sends it the trade's inputs and
              gets back the proof; nothing goes to another server.
            </li>
            <li>
              It holds no keys and no funds, and needs no account. Your wallet still adds the fees and signs every
              transaction, and you approve each one in the wallet.
            </li>
            <li>
              It runs in the background and restarts with Docker. Stop it any time with{" "}
              <code>docker stop proof-server</code>.
            </li>
          </ul>

          <h3>Set it up</h3>
          <ol>
            <li>
              Install{" "}
              <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noreferrer">
                Docker Desktop
              </a>{" "}
              and start it.
            </li>
            <li>
              In a terminal, run once:
              <code className="copy">{DOCKER}</code>
            </li>
            <li>
              In 1AM, set <i>Settings → Proof server</i> to <b>Local</b> (<code>http://localhost:6300</code>), so 1AM's own
              fee proof runs there too. That proof holds no position data; Local only makes it faster.
            </li>
            <li>
              Back here, press <b>Check again</b>. The wallet button turns green when this machine proves your trades.
            </li>
          </ol>

          <p className="muted">
            Your browser may ask once to let this site reach devices on your local network: that is the proof server.
            On a phone, or without Docker, the wallet proves instead, as in the table.
          </p>
        </div>
      </dialog>,
        document.body
      )}
    </>
  );
}

/** One line by an action button: where its proof is made, and the "read more". */
export function ProverLine() {
  const w = useWallet();
  if (!w.api) return null;
  return (
    <p className="prover-line">
      <span className={w.proverIsLocal ? "good" : "bad"}>●</span>{" "}
      {w.proverIsLocal ? "Proven on this machine" : `Proven by your wallet, on ${proverLabel(w.prover)}`} ·{" "}
      <WhyDocker label="How proving works" />
    </p>
  );
}

/**
 * How this wallet's transactions get proven, and how to make that private and
 * fast: the proof server on this machine (Docker) proves the contract call,
 * and 1AM set to its Local proof server proves its own fee proof there too.
 * Measured on preview, 2026-10-08: ~11–17 s a trade that way, ~40 s with 1AM's
 * in-browser fee proof.
 */
export function ProverSetup() {
  const w = useWallet();
  const [checking, setChecking] = useState(false);
  const [stillDown, setStillDown] = useState(false);
  const [hideTip, setHideTip] = useState(tipDismissed);

  if (!w.api) return null;

  if (!w.walletProves) {
    if (hideTip) return null;
    return (
      <div className="banner ok prover-setup">
        <span>
          <b>Proving on this machine.</b> Your positions never leave it. Tip: in 1AM, set <i>Settings → Proof server</i> to{" "}
          <b>Local</b> as well, so its fee proof takes seconds instead of ~30 s. <WhyDocker />
        </span>
        <button
          className="ghost small"
          onClick={() => {
            setHideTip(true);
            try {
              localStorage.setItem(TIP_KEY, "1");
            } catch {}
          }}
        >
          Got it
        </button>
      </div>
    );
  }

  async function recheck() {
    setChecking(true);
    setStillDown(!(await w.recheckProver().catch(() => false)));
    setChecking(false);
  }

  return (
    <div className="banner warn prover-setup">
      <div>
        <b>No proof server on this machine, so your wallet proves your trades</b>, on {proverLabel(w.prover)}. If 1AM is set to
        Proofstation, 1AM sees each position's size, direction and collateral. For private and fast trades:
        <ol>
          <li>
            Install{" "}
            <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noreferrer">
              Docker
            </a>{" "}
            and start Midnight's proof server, once:
            <code className="copy">{DOCKER}</code>
          </li>
          <li>
            In 1AM, set <i>Settings → Proof server</i> to <b>Local</b> (<code>http://localhost:6300</code>).
          </li>
        </ol>
        <span className="muted">
          No Docker? Set 1AM to <b>In-browser (WASM)</b>: private too, but experimental, slower, and not yet tested with
          zkperp's larger circuits.
        </span>{" "}
        <WhyDocker />
        {stillDown && (
          <p className="bad" style={{ margin: "6px 0 0" }}>
            Still no answer on localhost:6300.
          </p>
        )}
      </div>
      <button className="small" onClick={recheck} disabled={checking}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}
