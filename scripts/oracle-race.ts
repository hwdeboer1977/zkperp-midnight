// SPDX-License-Identifier: Apache-2.0

/**
 * The 2-of-3 oracle on the devnet: signers sending at once, and rotation.
 *
 *   npm run setup:local    # once: deploys zkperp and funds the three signer wallets
 *   npm run oracle:race
 *
 *   A  three signers, each from its own wallet, submit the same round at the
 *      same moment, each with another pair of signatures. Target: exactly one
 *      lands; the others are refused (their round is no longer newer).
 *   B  rotation: signers 1 and 2 replace signer 3's key; the new key then
 *      signs a price with signer 1, and the old one no longer can. Signers 1
 *      and 2 then put the old key back, so the relayers keep working.
 *
 * Each price is the contract's own, at the round after the contract's: run it
 * while the relayers are stopped, or they wait for the next Chainlink round.
 */

import chalk from "chalk";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { LOCAL, requireLocal, walletSeed } from "../core/network.js";
import { getDeployment } from "../core/contracts.js";
import { oracleWalletSeed, readyWallet } from "../core/trader.js";
import { circuitNow, readLedger, submitPrice, submitSignedPrice, type ContractHandle } from "../core/perp.js";
import { handle } from "../core/session.js";
import { randomScalar } from "../core/liquidatorNote.js";
import { buildWallet, waitForSync, type BuiltWallet } from "../core/wallet.js";
import { oracleSecrets, quorum, rotationMessage, sign, signPrice, SIGNER_SLOTS, type PriceReport } from "../core/oracle.js";

const step = (s: string) => console.log(`\n${chalk.blue.bold("▶")} ${chalk.bold(s)}`);
const info = (s: string) => console.log(chalk.gray(`   ${s}`));

let failures = 0;
const verdict = (name: string, ok: boolean, what: string) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? chalk.green("✓") : chalk.red("✗")} ${name}: ${what}`);
};

async function attempt(label: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const txHash = await fn();
    const r = { label, ok: true, ms: Date.now() - start, detail: txHash };
    console.log(`   ${chalk.green("landed")} ${label} after ${(r.ms / 1000).toFixed(1)}s`);
    return r;
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 300);
    console.log(`   ${chalk.red("refused")} ${label} after ${((Date.now() - start) / 1000).toFixed(1)}s`);
    info(`  ${detail}`);
    return { label, ok: false, ms: Date.now() - start, detail };
  }
}

async function main() {
  requireLocal("npm run oracle:race");
  setNetworkId(LOCAL.networkId);
  const devSeed = walletSeed(LOCAL);
  const perpAddress = getDeployment(LOCAL.networkId, "zkperp");
  if (!perpAddress) throw new Error("no zkperp on the devnet: run npm run setup:local first");
  const secrets = oracleSecrets(devSeed);

  step("Signer wallets");
  let dev: BuiltWallet | undefined;
  const fundFromDev = async () => {
    dev ??= await buildWallet({ kind: "seed", value: devSeed }, LOCAL);
    await waitForSync(dev, () => {});
    return dev;
  };
  const wallets: BuiltWallet[] = [];
  const perps: ContractHandle[] = [];
  try {
    for (const slot of SIGNER_SLOTS) {
      const seed = oracleWalletSeed(devSeed, slot);
      const w = await readyWallet(fundFromDev, seed, LOCAL, info, `signer ${slot + 1}`);
      wallets.push(w);
      perps.push(await handle(w, seed, "zkperp", perpAddress));
      info(`signer ${slot + 1} ${w.unshieldedAddress}`);
    }
    const pc = perps[0].module.pureCircuits;

    step("A: three signers submit the same round at once");
    const l0 = await readLedger(perps[0]);
    const report: PriceReport = { round: l0.priceRound + 1n, price: l0.markPrice, updatedAt: circuitNow() };
    const sigs = SIGNER_SLOTS.map((slot) => ({ slot, signature: signPrice(pc, perpAddress, report, secrets[slot]) }));
    info(`round ${report.round}, $${Number(report.price) / 1e6}`);
    const pairs = [[0, 1], [0, 2], [1, 2]];
    const results = await Promise.all(
      pairs.map(([i, j], n) =>
        attempt(`signer ${n + 1}'s wallet, with signatures ${i + 1}+${j + 1}`, () =>
          submitSignedPrice(perps[n], report, [sigs[i], sigs[j]])
        )
      )
    );
    const l1 = await readLedger(perps[0]);
    const landed = results.filter((r) => r.ok).length;
    verdict("A", landed === 1 && l1.priceRound === report.round, `${landed} of 3 landed; the contract is at round ${l1.priceRound}, signed by ${[...l1.priceSigners].map((s: bigint) => Number(s) + 1).join("+")}`);
    const losers = results.filter((r) => !r.ok);
    verdict(
      "A, the losers",
      losers.every((r) => /not newer|FailFallible|Invalid Transaction|conflict/i.test(r.detail)),
      losers.length ? "refused for the round, not for a bad signature" : "none"
    );

    step("B: rotation");
    const oldKey = (await readLedger(perps[0])).signers[2];
    const fresh = randomScalar();
    const newKey = pc.signerPublicKey(fresh);
    const rotate = async (key: any, by: ContractHandle) => {
      const epoch = (await readLedger(by)).signerEpoch;
      const msg = rotationMessage(pc, perpAddress, epoch, 2, key);
      const tx = await by.deployed.callTx.rotateSigner(2n, key, ...quorum([
        { slot: 0, signature: sign(pc, secrets[0], msg) },
        { slot: 1, signature: sign(pc, secrets[1], msg) },
      ]));
      return tx.public.txHash as string;
    };
    const r1 = await attempt("signers 1+2 put a new key in slot 3", () => rotate(newKey, perps[0]));
    const l2 = await readLedger(perps[0]);
    verdict("B, rotate", r1.ok && l2.signers[2].x === newKey.x && l2.signerEpoch === l1.signerEpoch + 1n, `epoch ${l2.signerEpoch}`);

    const byNew = await attempt("signers 1 + new 3 set a price", () => submitPrice(perps[1], l2.markPrice, new Map([[0, secrets[0]], [2, fresh]])));
    verdict("B, new key signs", byNew.ok, byNew.ok ? "accepted" : byNew.detail);
    const byOld = await attempt("signers 1 + old 3 set a price", () => submitPrice(perps[2], l2.markPrice, new Map([[0, secrets[0]], [2, secrets[2]]])));
    verdict("B, old key refused", !byOld.ok && /does not match/.test(byOld.detail), byOld.ok ? "accepted!" : "refused");

    const r2 = await attempt("signers 1+2 put the old key back", () => rotate(oldKey, perps[1]));
    const l3 = await readLedger(perps[0]);
    verdict("B, restore", r2.ok && l3.signers[2].x === oldKey.x, `epoch ${l3.signerEpoch}`);
  } finally {
    for (const w of wallets) await w.facade.stop();
    if (dev) await dev.facade.stop();
  }
  console.log(failures ? chalk.red(`\n${failures} check(s) failed`) : chalk.green("\nall checks passed"));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(chalk.red(`\n✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
