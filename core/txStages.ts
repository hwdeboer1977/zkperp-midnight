// SPDX-License-Identifier: Apache-2.0

/**
 * Where a contract call is: proving, in the wallet (fees and signature), or
 * submitted and waiting for its block. The browser reports the same steps
 * (frontend/src/lib/providers.ts); this is the services' version, for the
 * keeper's logs and its /health.
 */

export type TxStage = "proving" | "wallet" | "submitting";

/**
 * Makes `providers` call `onStage` as each call reaches a step. Patches the
 * provider objects in place, so a contract already found with them (its
 * `callTx`) reports too.
 */
export function reportStages(providers: any, onStage: (stage: TxStage) => void): void {
  const wrap = (target: any, method: string, stage: TxStage) => {
    const original = target[method].bind(target);
    target[method] = (...args: any[]) => {
      onStage(stage);
      return original(...args);
    };
  };
  wrap(providers.proofProvider, "proveTx", "proving");
  wrap(providers.walletProvider, "balanceTx", "wallet");
  wrap(providers.midnightProvider, "submitTx", "submitting");
}
