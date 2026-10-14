// SPDX-License-Identifier: Apache-2.0

import { ACTION_LABEL, STEPS, STEP_LABEL, useKeeper } from "../lib/keeper";
import { dismissNotice, useNotices } from "../lib/notices";

/**
 * What the keepers are doing, while the trader has something they may act on:
 * shown only when one is busy, or when all are down while `waiting` (a limit
 * order whose price is reached) needs one.
 */
export function KeeperLine({ active, waiting = false }: { active: boolean; waiting?: boolean }) {
  const k = useKeeper(active);
  if (k === "down") {
    return waiting ? (
      <div className="keeper-line bad">No keeper is reachable: a reached order waits until one runs again.</div>
    ) : null;
  }
  if (!k?.keeper.busy) return null;
  const b = k.keeper.busy;
  return (
    <div className="keeper-line" title={`The keeper says what it is doing, not for whom · ${k.up} of ${k.of} keepers up`}>
      <span className="spinner" />
      <span>
        Keeper{k.keeper.keeper ? ` ${k.keeper.keeper}` : ""} is {ACTION_LABEL[b.action]} · {STEP_LABEL[b.step]} ({STEPS.indexOf(b.step) + 1} of {STEPS.length}) · {b.stepSeconds}s
      </span>
    </div>
  );
}

/** The keeper's actions for this trader, as they land. */
export function Notices() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.tone}`}>
          <b>{n.title}</b>
          <span>{n.text}</span>
          <button className="ghost small" onClick={() => dismissNotice(n.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
