# Roadmap: after the preview smoke test

This file records the next steps agreed on 2026-10-08, after the first `preview` deployment (one oracle, one keeper, every key derived from `WALLET_SEED_PREVIEW`) ran trades and a liquidation end to end. That deployment is a smoke test: the contract changes below need a fresh deployment.

| # | Step | Contract change? | Size |
|---|---|---|---|
| 1 | More tests: property tests, `/check` fuzzing, frontend unit tests | No | Medium |
| 2 | Per-role keys | No | Small |
| 3 | 2-of-3 oracle, with signer rotation | **Yes** | Medium |
| 4 | Three independent keepers, paid the liquidation fee | **Yes** | Medium |
| 5 | A second market (BTC-USD) | No, as a separate deployment | Medium |

Steps 3 and 4 change the contract, so they ship together in **one** redeployment. Step 1 comes first, so those changes land on a safety net.

## 1. More tests

**Contract change:** none.

What exists today:

- `test/zkperp.test.mjs` (about 1,100 lines) runs the contract's circuits through its JavaScript runtime: opens, closes, liquidations, LP flows, refusals.
- `test/notes.test.mjs`, `test/password.test.mjs`, `test/pusdc.test.mjs`.
- `npm run demo` and `npm run liquidation` run every settlement path through the real proof server on the devnet.

What is missing, in order of value:

### 1a. Property tests of the money

Random sizes, collateral, leverage, entry and exit prices, and hold times, many thousands of cases, checking invariants rather than examples:

- [ ] Settlement conserves value: what leaves the coin (to pool, treasury, trader) equals collateral plus opening fee, plus any profit from the pool.
- [ ] The pool never goes negative, and never pays more than `maxPayout` per position.
- [ ] A loss never exceeds the collateral; fees never exceed what equity is left.
- [ ] `isLiquidatable` is true exactly when the circuit accepts `liquidatePosition`, and a position in profit is never liquidatable.
- [ ] `liquidationPrice` lands within one price unit of where `isLiquidatable` flips.
- [ ] Share price: a deposit followed by a withdrawal never returns more than was deposited; rounding is always in the pool's favour.
- [ ] Capacity: no sequence of opens, closes, deposits and withdrawals leaves reserved liquidity above the pool.

Run each against both `core/math.ts` and the circuit's JavaScript, so the two cannot drift.

### 1b. Fuzzing through the proof server's `/check`

Proofs evaluate **every** branch of an `if`; only the taken branch's effects are kept. The JavaScript runtime runs only the taken branch. So a value that goes negative in an untaken branch breaks the proof while every local test passes. The first loss close on the devnet failed exactly this way.

`/check` validates a circuit's inputs against its constraints without the expensive proof, so it catches this class cheaply.

- [ ] Fuzz `openPosition`, `closePosition` and `liquidatePosition` with random valid inputs, especially edge cases: flat price, a profit at the cap, a profit above the cap, a wipe-out, maximum leverage, minimum collateral, a borrow fee larger than the equity left.
- [ ] Same for `addLiquidity` and `removeLiquidity` at share-price and capacity boundaries.
- [ ] Run it in CI against a proof server container.

### 1c. Frontend unit tests

The frontend has none today. Worth covering:

- [ ] `sizeFor` (Trade): never exceeds the contract's leverage bound, for every leverage and fee.
- [ ] `closingOf` (`history.ts`): matches an exact close's numbers when given the exact close time.
- [ ] Recovery: notes rebuild the same records; "Lock and clear" followed by unlock restores every open position; a note from another wallet account is skipped.
- [ ] Oracle staleness and deviation logic, including the expiring window.
- [ ] `useCandles`: the live price folds into the right candle across an interval boundary.

**Done when** `npm test` runs all of it, CI runs it on every push, and the `/check` fuzzer has run at least once against each circuit.

## 2. Per-role keys

**Contract change:** none.

Today every role derives from one seed (`WALLET_SEED_PREVIEW`): the deployer, the oracle admin secret, the liquidator key, the keeper wallet and the treasury wallet. One leaked seed takes all of them.

- [ ] Separate secrets in `.env`: deployer, each oracle signer, each keeper's liquidator key and wallet, treasury wallet.
- [ ] Each service reads only its own secrets.
- [ ] A relayer's or keeper's wallet only pays DUST; the authority is the secret behind a hash stored in the contract. Keep that distinction in the docs.
- [ ] `npm run setup:preview` generates or takes each key, and prints which public values go in the contract.

## 3. 2-of-3 oracle

**Contract change:** yes.

Today `admin` is one sealed hash and `setPrice` checks one secret: one relayer down stops prices (and, after `maxPriceAge`, all trading); one leaked secret sets any price.

Design:

- The contract stores three signer hashes.
- Each relayer reads the same Chainlink round and submits `(roundId, price, updatedAt)` with its own secret, proven in zero knowledge.
- The first submission for a round is stored as pending. The second **matching** submission from a different signer sets `markPrice` and `priceTime`. A mismatch is refused.
- The existing rules stay: `updatedAt` not in the future, not older than the current price.
- **Rotation:** any two signers can replace a third. Today `admin` is fixed at deployment.

Effect on trades: none. Trades still read only `markPrice` and `priceTime`; pending submissions live in their own ledger fields, so they add no conflicts (we measured that only exact reads conflict).

Tasks:

- [ ] Contract: signer set, pending submission, matching rule, rotation circuit.
- [ ] Relayer: a `--signer` option; three instances, each with its own secret and wallet.
- [ ] Tests: two matching submissions set the price; one does not; mismatched rounds are refused; a non-signer is refused; rotation needs two signers.
- [ ] The Public page shows signer liveness (which signers submitted the last round).

Open question: will the oracle signers also be run by independent parties, like the keepers? The design is the same either way; it changes who holds the secrets in step 2.

## 4. Three independent keepers

**Contract change:** yes. **Decided 2026-10-08:** the keepers are run by independent parties, so each needs its own key.

Today the open circuit writes one liquidator note, encrypted in the circuit to the single `liquidator` key. `liquidatePosition` itself is permissionless: whoever knows a position's fields can liquidate it, and the note is how the keeper learns them. With one key, one keeper down means no liquidations, and bad debt grows.

Design:

- The contract stores three keeper public keys instead of one `liquidator`.
- The open circuit writes **three** liquidator notes, one per keeper key, so any single keeper can liquidate alone.
- **The liquidation fee goes to the keeper that liquidates** (its `ownPublicKey()`), instead of to the treasury. Without it, an independent operator has no reason to run a keeper.
- Keepers race for the fee. That is fine: only one liquidation of a position can land (the nullifier); the others fail and cost the losers a DUST fee. A keeper may still stagger itself to save fees.
- **Rotation:** replace a keeper key, with the same 2-of-3 authority as the oracle, or a separate admin set.

Costs and trade-offs:

- Each extra note is one more in-circuit ECDH and encryption: about 0.1–0.3 MB of proving key each (measured with the cost probes), so the open circuit grows by well under 1 MB. It must stay far below the limit 1AM can carry (37 MB worked, 81 MB was refused, measured 2026-10-07); keep `slice` out of the open circuit, at about 4 MB of proving key each.
- Proving an open takes a little longer.
- **Privacy:** each keeper sees every position's size, direction, entry, collateral and payout key, never the owner secret. Three keepers means three parties with that view, not one.
- **Rotation does not revoke:** a removed keeper keeps its view of positions opened while it was a keeper, because their notes were written to its key.

Tasks:

- [ ] Contract: three keeper keys; three notes per open; liquidation fee to the caller; key rotation.
- [ ] Keeper: takes its own key and wallet; decrypts only its own note per position.
- [ ] Frontend: the Privacy inspector and Public page say "three keepers"; the Liquidity explainer and docs say the liquidation fee goes to the keeper.
- [ ] Tests: each keeper alone can liquidate; a second liquidation of the same position is refused; the fee reaches the liquidating keeper; rotation.
- [ ] Re-measure the open circuit's proving-key size and proving time.

## 3 + 4. One redeployment

- [ ] Ship steps 3 and 4 in one contract version.
- [ ] Run `npm test`, the `/check` fuzzer, `npm run demo` and `npm run liquidation` on the devnet.
- [ ] Before redeploying `preview`: close open positions on the old deployment, and let LPs withdraw. There is no upgrade path; the new contract has new addresses, a new pool and a new pUSDC token.
- [ ] `npm run setup:preview` with the per-role keys from step 2; start three relayers and three keepers.
- [ ] Re-run the preview checks: open, close, liquidation (with `npm run price:preview`, which in 2-of-3 needs two signers), recovery on a second browser.

## 5. A second market

**Contract change:** none, as a separate deployment.

Today the contract holds one `markPrice`, one pool and one slot count.

**Chosen for now: one contract per market.**

- Deploy zkperp again with the BTC-USD Chainlink feed, its own pool and its own relayers.
- The frontend gets a market selector; Portfolio and Liquidity show each market.
- Cost: liquidity is split across pools, and each position's market is public, because the contract it calls gives it away.

**Later, if shared liquidity matters: one multi-market contract.**

- `Position` gains a market, prices are kept per market, and the pool is shared or reserved per market.
- To keep a position's market private, every trade must read all N prices and select its own inside the proof, because a ledger read with a private key is not private on Midnight. Then every price update in any market conflicts with in-flight trades in every market: more "price moved, try again".
- Disclosing the market avoids that, but gives up the privacy gain over separate deployments.
- It changes the commitment, both note formats and the recovery code, so it is a larger change than steps 3 and 4.

Tasks for the separate deployment:

- [ ] `setup` takes a market (feed, name) and writes a deployment per market.
- [ ] The frontend config lists markets; Trade gets a market selector; the candles follow the market.
- [ ] The relayer and keeper run per market.
