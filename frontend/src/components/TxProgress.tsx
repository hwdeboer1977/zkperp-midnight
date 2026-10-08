// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useNow } from "../lib/hooks";
import { onTxStage, type TxStage } from "../lib/providers";
import { proverLabel, useWallet } from "../lib/wallet";

export type Step = "prepare" | TxStage | "done";
const ORDER: Step[] = ["prepare", "proving", "wallet", "submitting"];

/**
 * A transaction's steps as the providers report them (providers.ts), with
 * when each started. `start` before the call, `done` or `fail` after.
 */
export function useTxProgress() {
  const [step, setStep] = useState<Step | null>(null);
  const [times, setTimes] = useState<Partial<Record<Step, number>>>({});
  const active = useRef(false);

  useEffect(
    () =>
      onTxStage((s) => {
        if (!active.current) return;
        setStep(s);
        setTimes((t) => ({ ...t, [s]: t[s] ?? Date.now() }));
      }),
    []
  );

  const start = useCallback(() => {
    active.current = true;
    setStep("prepare");
    setTimes({ prepare: Date.now() });
  }, []);
  const done = useCallback(() => {
    active.current = false;
    setTimes((t) => ({ ...t, done: Date.now() }));
    setStep("done");
  }, []);
  const fail = useCallback(() => {
    active.current = false;
    setStep(null);
  }, []);
  return { step, times, start, done, fail };
}

/** The steps of a transaction in flight, with how long each took. */
export function TxProgress({ progress, prepare }: { progress: ReturnType<typeof useTxProgress>; prepare: string }) {
  const w = useWallet();
  useNow(1000);
  const { step, times } = progress;
  if (!step) return null;
  const labels: Record<string, string> = {
    prepare,
    proving: `Prove the contract call on ${proverLabel(w.prover)}${w.walletProves ? " (through your wallet)" : ""}`,
    wallet: "Wallet adds the fee (DUST) and signs",
    submitting: "Submit to Midnight",
  };
  const at = step === "done" ? ORDER.length : ORDER.indexOf(step);
  const now = Date.now();
  return (
    <ol className="steps">
      {ORDER.map((id, i) => {
        const state = i < at ? "done" : i === at ? "active" : "todo";
        const begin = times[id];
        const end = i + 1 < ORDER.length ? times[ORDER[i + 1]] : times.done;
        const secs = begin ? Math.max(0, Math.round(((state === "done" ? (end ?? now) : now) - begin) / 1000)) : null;
        return (
          <li key={id} className={state}>
            <i>{state === "done" ? "✓" : i + 1}</i>
            <span>{labels[id]}</span>
            {secs !== null && <time>{secs}s</time>}
          </li>
        );
      })}
    </ol>
  );
}
