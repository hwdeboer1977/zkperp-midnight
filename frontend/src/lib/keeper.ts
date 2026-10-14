// SPDX-License-Identifier: Apache-2.0

/**
 * The keepers' /health (services/keeper/keeper.ts): what each is doing now and
 * how its last action ended. It names the kind of action and the step, never
 * whose position or order; the trader infers that it is likely theirs. There
 * are three independent keepers; any one of them acts alone.
 */

import { useEffect, useState } from "react";
import { useConfig } from "./hooks";

export type KeeperAction = "liquidation" | "order" | "limit";
export type KeeperStep = "prepare" | "proving" | "wallet" | "submitting";

export interface KeeperHealth {
  /** Which keeper, 1 to 3. */
  keeper?: number;
  contract: string;
  checkEverySeconds: number;
  lastTickSecondsAgo: number | null;
  busy: { action: KeeperAction; step: KeeperStep; stepSeconds: number; seconds: number } | null;
  last: { action: KeeperAction; ok: boolean; step: KeeperStep; at: string; secondsAgo: number; seconds: number } | null;
}

export const ACTION_LABEL: Record<KeeperAction, string> = {
  liquidation: "liquidating a position",
  order: "executing a stop loss or take profit",
  limit: "filling a limit order",
};

export const STEPS: KeeperStep[] = ["prepare", "proving", "wallet", "submitting"];

export const STEP_LABEL: Record<KeeperStep, string> = {
  prepare: "preparing",
  proving: "proving",
  wallet: "paying the fee (DUST) and signing",
  submitting: "submitted, waiting for the block",
};

/** The three keepers' health, as one: the busy one if any, and how many answer. */
export interface KeepersHealth {
  /** A keeper that is busy, else the first that answers. */
  keeper: KeeperHealth;
  up: number;
  of: number;
}

/**
 * The keepers' health, polled every `everyMs` while `active`: "down" when none
 * answers for this contract, null before the first answers or while inactive.
 */
export function useKeeper(active: boolean, everyMs = 4000): KeepersHealth | "down" | null {
  const config = useConfig();
  const [health, setHealth] = useState<KeepersHealth | "down" | null>(null);
  const bases = config ? config.services.keepers ?? [config.services.keeper ?? "/svc/keeper"] : undefined;
  const key = bases?.join(",");
  useEffect(() => {
    if (!bases || !active) return setHealth(null);
    let live = true;
    const one = (base: string): Promise<KeeperHealth | null> =>
      fetch(`${base}/health`)
        .then((r) => (r.ok ? r.json() : null))
        .then((h) => (h && config && h.contract === config.contracts.zkperp ? h : null))
        .catch(() => null);
    const tick = () =>
      Promise.all(bases.map(one)).then((all) => {
        if (!live) return;
        const up = all.filter((h): h is KeeperHealth => h !== null);
        setHealth(up.length ? { keeper: up.find((h) => h.busy) ?? up[0]!, up: up.length, of: bases.length } : "down");
      });
    void tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, everyMs, config]);
  return health;
}
