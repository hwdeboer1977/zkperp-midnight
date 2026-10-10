// SPDX-License-Identifier: Apache-2.0

/**
 * The keeper's /health (services/keeper/keeper.ts): what it is doing now and
 * how its last action ended. It names the kind of action and the step, never
 * whose position or order; the trader infers that it is likely theirs.
 */

import { useEffect, useState } from "react";
import { useConfig } from "./hooks";

export type KeeperAction = "liquidation" | "order" | "limit";
export type KeeperStep = "prepare" | "proving" | "wallet" | "submitting";

export interface KeeperHealth {
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

/**
 * The keeper's health, polled every `everyMs` while `active`: "down" when it
 * does not answer, null before the first answer or while inactive.
 */
export function useKeeper(active: boolean, everyMs = 4000): KeeperHealth | "down" | null {
  const config = useConfig();
  const [health, setHealth] = useState<KeeperHealth | "down" | null>(null);
  const url = config ? `${config.services.keeper ?? "/svc/keeper"}/health` : undefined;
  useEffect(() => {
    if (!url || !active) return setHealth(null);
    let live = true;
    const tick = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : "down"))
        .then((h) => live && setHealth(config && h !== "down" && h.contract !== config.contracts.zkperp ? "down" : h))
        .catch(() => live && setHealth("down"));
    void tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url, active, everyMs, config]);
  return health;
}
