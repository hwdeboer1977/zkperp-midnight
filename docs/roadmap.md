# Roadmap: after the preview smoke test

This file records the next steps agreed on 2026-10-08, after the first `preview` deployment (one oracle, one keeper, every key derived from `WALLET_SEED_PREVIEW`) ran trades and a liquidation end to end. That deployment is a smoke test: the contract changes below need a fresh deployment.

| # | Step | Contract change? | Size |
|---|---|---|---|
| 1 | More tests: property tests, `/check` fuzzing, frontend unit tests | No | Medium |
| 2 | Per-role keys | No | Small |
| 3 | 2-of-3 oracle, with signer rotation | **Yes** | Medium |
| 4 | Three independent keepers, paid the liquidation fee | **Yes** | Medium |
| 5 | A second market (BTC-USD) | No, as a separate deployment | Medium |
| 6 | Take profit and stop loss, executed by keepers | **Yes** | Medium |
| 7 | Limit orders, with escrowed collateral | **Yes** | Large |
| 8 | Load test with 10 trading agents | No | Medium |
| 9 | Launch on preprod instead of preview | No, a fresh deployment | Medium |
| 10 | Add collateral (then increase size), after wave 2 | **Yes** | Small–Medium |
| 11 | Bracket orders: TP/SL attached to a limit order, after wave 2 | No, frontend first | Small |
| 12 | Partial close, after wave 2 | **Yes** | Medium |
| 13 | Funding rate and per-side open interest caps, after wave 2 | Design note first | Large |

Steps 3, 4 and 6 change the contract, so they ship together in **one** redeployment. Step 7 is a later contract version of its own. Step 1 comes first, so those changes land on a safety net. Step 8 then tests the new version under load, and step 9 launches it on preprod. Steps 10–13 were added on 2026-10-11, after limit orders, stop loss and take profit were in place. They come **after wave 2 of the buildathon**: for wave 2 the orders (market, limit, stop loss, take profit) stay as they are.

## Next buildathon wave: scope

Decided 2026-10-11. In this order:

1. **Step 1b, `/check` fuzzing** (with the property tests of 1a where cheap), over the circuits as they are today, `executeOrder` and `executeLimitOrder` included. It is the safety net for the contract changes below.
2. **Step 2, per-role keys.** Independent oracle signers and keepers each need their own secret.
3. **Steps 3 + 4, the 2-of-3 oracle and three keepers**, in one contract version and one redeployment. The orders' internals change, not their behaviour: each TP/SL and limit note is sealed to three keeper keys, and `executeLimitOrder` writes three liquidator notes, so the order tests run again. Test early on the devnet: the deploy ceiling (about 14–15 circuits, the new ones in `DEFERRED`), and 1AM's 37 MB proving-key limit (`closePosition` is 38.8 MB already; the fee-to-caller change must not grow it).
4. **Step 5, a second market (BTC-USD)**, deployed from the finished contract: its own pool, three relayers on the BTC/USD feed, three keepers, and a market selector in the frontend.

Out of this wave: the order features stay as they are. Step 6's merge of `executeOrder` into `closePosition` waits, as do steps 10–13.

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

- [x] Fuzz `openPosition`, `closePosition` and `liquidatePosition` with random valid inputs, especially edge cases: flat price, a profit at the cap, a profit above the cap, a wipe-out, maximum leverage, minimum collateral, a borrow fee larger than the equity left.
- [x] Same for `addLiquidity` and `removeLiquidity` at share-price and capacity boundaries.
- [x] Also every other circuit: `setPrice`, `depositFees`, `placeOrder`, `cancelOrder`, `executeOrder`, `placeLimitOrder`, `executeLimitOrder`, `cancelLimitOrder`.

`npm run test:fuzz -- [cases] [seed]` (2026-10-11, `test/check.fuzz.mjs`). Each case deploys locally with random parameters and walks a random life through every circuit, biased to the edges; each call the runtime accepts is built into the transaction the SDK would prove and sent to `/check`. Two controls run first: an honest call passes, a forged input is refused. About 0.25 s per call; 200 cases (about 2,000 calls) take under ten minutes. First run: every accepted call passed `/check`.

What the fuzzer found in the runtime's refusals:

- [x] **A close in profit is refused when the pool is full.** `settle` calls `repool` before `freeSlots.increment(1)`, so when every slot is taken and the profit moves the pool below a slot boundary, `repool` finds no free slot to retire and asserts "that liquidity is reserved for open positions", although the closing position's own slot is about to free. A trader cannot close a winning position, and a take profit cannot execute, until another position frees a slot or an LP deposits. Reproduced: a pool of 1 slot plus 1,000 units, one long, a 10% rise. Fixed 2026-10-11: `settle` frees the slot before `repool`; regression test "a full pool" in `test/zkperp.test.mjs`. Ships with the steps 3 + 4 redeployment; `preview` still runs the old contract.
- [ ] A position whose loss would add more than 65,535 slots to the pool cannot be closed or liquidated ("the pool changes by too many slots at once"). Unreachable with real parameters (at a `maxPayout` of 100,000 pUSDC it takes a loss above 6.5 billion pUSDC), but worth bounding at open, or splitting the step.
- [ ] Each new circuit joins the fuzzer as it lands: `addCollateral` (step 10) and the partial close (step 12).
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

**Contract change:** yes. **Decided 2026-10-13:** a threshold-signed report, aggregated off-chain, as Chainlink OCR, Chronicle and Pyth do. Signers do not vote on chain.

Today `admin` is one sealed hash and `setPrice` checks one secret: one relayer down stops prices (and, after `maxPriceAge`, all trading); one leaked secret sets any price.

Why not votes on chain: every signer's submission would read and write the same pending round, so submissions sent together conflict (only the first lands; the others fail as `FailFallible` and pay their fee), and a price update takes two proofs in a row. A signed report is one transaction per round, holds no state between rounds, and has nothing to race.

Design:

- The contract stores three signer public keys (Jubjub points), instead of `admin`.
- Each signer reads the same Chainlink round and signs the report `(market, roundId, price, updatedAt)` with Schnorr over Jubjub. `market` is the contract's own address, so a report for one market cannot be replayed on another.
- Signers share their signatures off-chain (each relayer serves its own over HTTP). Whoever holds two first submits `setPrice(report, i, j, sig_i, sig_j)`, with `i < j`.
- Transmission is staggered: signer *n* waits (*n* − 1) × 20 s after it sees a round, skips the round once it is on chain, and waits while a lower signer says it is transmitting it (its `/health`). Normally one transaction per round; if the first transmitter is down, the next one sends. Measured on the devnet (2026-10-13): two signers sending the same round at once, exactly one lands, and the other fails on chain (`FailFallible`) and **pays its fee**, so the stagger is about cost, not safety.
- **What the chain proves:** the proof shows that two different stored signers signed exactly this report. The validators verify it, and without it no transaction can move the price, ours included. The signatures stay private inputs.
- **What is public:** the price, `roundId` and `updatedAt`, and which two signers signed (`priceSigners`), for liveness on the Public page. With `roundId` published, anyone can compare every update against Chainlink's own round history.
- The rules stay: `updatedAt` not in the future and not older than the current price; and now `roundId` strictly increasing, so no round lands twice.
- **Rotation:** any two signers replace a key in a slot (a third signer's, or their own), with a signed rotation message that names a rotation counter, so it cannot be replayed. A new key must differ from the other two. Today `admin` is fixed at deployment.

Measured on a probe (2026-10-13): verifying two signatures costs about 1.35 MB of proving key. The challenge enters `ecMul` as a 128-bit value, passed in two halves the circuit checks against the hash, because `ecMul` refuses scalars at or above the Jubjub order.

Effect on trades: none. Trades still read only `markPrice` and `priceTime`; the signer keys, round and signer mask live in their own ledger fields.

What the proof does not show: that the three keys are held by independent parties. For the buildathon demo, one operator runs all three, each with its own key and wallet; say so on the Public page.

Tasks:

- [x] Contract: signer keys, signed `setPrice`, `roundId` and `priceSigners`, rotation circuit (`rotateSigner`, in `DEFERRED`).
- [x] Core: signing and key helpers (`core/oracle.ts`); scripts and the fuzzer sign with two of three dev signers.
- [x] Relayer: a `--signer` option; serves its signature per round, fetches its peers', submits on its stagger. Three instances, each with its own secret and wallet.
- [x] Tests: two valid signatures set the price; one signer twice, a wrong slot, a tampered signature, an outsider and a mismatched report are refused; a replayed or older round is refused; rotation needs two signers and cannot be replayed.
- [x] Devnet: run every branch through the proof server (`/check`), and three relayers sending at once.
- [ ] The Public page shows the round and which signers signed it. (Built; not yet checked in the browser.)

**Status 2026-10-13, devnet:** 14-circuit deploy accepted (`rotateSigner` deferred). Three relayers, each with its own key, wallet and LevelDB store: a real Chainlink round was transmitted by signer 1 alone while 2 and 3 waited (19 s to land). `npm run oracle:race`: three wallets sending one round at once, one landed and two failed as `FailFallible` (fees paid); a rotation, a price signed with the new key, the old key refused, and the rotation back all worked. `/check` fuzzer: 193 calls, 0 failures.

**Status 2026-10-13, preview:** redeployed as zkperp `cba3a990…` (14 circuits, `rotateSigner` deferred), with the signer keys and wallets as separate secrets in `.env` (`ORACLE_SIGNER_<n>_PREVIEW`, `ORACLE_<n>_SEED_PREVIEW`). Chainlink round …892 ($2,500.67): all three signed within 2.3 s; signer 1 transmitted with signatures 1 + 2 and it landed in 20 s; signer 2's turn came while signer 1 was still sending, so it waited; no duplicate was sent. Not yet on preview: rotation, `oracle:race` (devnet only), the trader flows against the new deployment.

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

## 3 + 4 + 6. One redeployment

- [ ] Ship steps 3, 4 and 6 in one contract version.
- [ ] Run `npm test`, the `/check` fuzzer, `npm run demo` and `npm run liquidation` on the devnet.
- [ ] Before redeploying `preview`: close open positions on the old deployment, and let LPs withdraw. There is no upgrade path; the new contract has new addresses, a new pool and a new pUSDC token.
- [ ] `npm run setup:preview` with the per-role keys from step 2; start three relayers and three keepers.
- [ ] Re-run the preview checks: open, close, liquidation (with `npm run price:preview`, which in 2-of-3 needs two signers), a take profit and a stop loss, recovery on a second browser.

### Circuit count and the deploy limit (noted 2026-10-09)

A deploy with all 13 circuits (after limit orders) is refused: "1010: Invalid Transaction: Transaction would exhaust the block limits". midnight-polisZK hit the same ceiling at about 12. Since 2026-10-09 the deploy carries 7 circuits and setup inserts the rest afterwards, one maintenance transaction each (`DEFERRED` in `core/session.ts`). The limit applies to one transaction, so more circuits no longer block a deploy.

Expected count after steps 3 and 4:

| | Circuits |
|---|---|
| Today, with limit orders | 13 |
| Step 3: `setPrice` takes a 2-of-3 signed report (same circuit), plus a rotation circuit | +1 |
| Step 4: three notes in `openPosition` and the fee to the caller in `liquidatePosition` (no new circuits), plus key rotation | +1, or 0 if one rotation circuit serves signers and keepers |
| Step 6, if `executeOrder` merges into `closePosition` | −1 |
| **Total** | **about 14–15** |

Tasks:

- [ ] Add each new circuit to `DEFERRED`, and deploy on the devnet as soon as the circuits exist: that is the test. Each insert adds about 15 s to setup.
- [ ] Watch for a limit not yet seen: total contract state size (each verifier key adds about 2 KB, so 15 keys is about 30 KB; no cap known, none tested). Check that preview and preprod accept the deploy and the inserts as the devnet does.
- [ ] Keep the trader's circuits within 1AM's proving-key limit (37 MB carried, 81 MB refused). Three keeper notes add about 0.1–0.3 MB each to `openPosition` (11 MB). `closePosition` (38.8 MB) is already just above 37 MB, so the fee-to-caller change in close and liquidate must not grow it.
- [ ] Limit orders need three keepers too: `executeLimitOrder` writes the new position's keeper notes in the circuit, so three (keeper-proven, 21.6 MB today). The trigger-order and limit notes the trader seals outside the circuit become three each, at no proof cost.
- [ ] Rotation of oracle signers and keepers goes through the contract's own circuits, signed by two of three, never through the maintenance key. Freezing the maintenance authority before preprod (step 9) then leaves rotation working.

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

## 6. Take profit and stop loss

**Contract change:** yes. Ships with steps 3 and 4.

**Status 2026-10-08:** stop loss and take profit built in the contract (`placeOrder`, `cancelOrder`, `executeOrder`), the core code, the keeper and the tests, and run on the devnet with the keeper service (`npm run stoploss -- --keeper`). Separate orders, not inside the position commitment. See `docs/privacy.md`, section 5.

**Status 2026-10-09:** the frontend sets, moves and cancels orders, and `preview` was redeployed with this contract. A take profit placed from the browser was executed there by the keeper (at a price set with `npm run price:preview`), and paid out exactly as computed. Not yet: the execution fee, merging into `closePosition`.

Today only the owner can close a position (with the owner secret), and keepers can only liquidate. A take profit or stop loss must fire while the trader is offline, so a keeper has to send the close. A browser tab that closes the position itself needs no contract change, but fails exactly when the laptop is shut: at most an extra, not the feature.

Design:

- **Attach:** at open, or later in a small transaction of its own, the trader commits to trigger levels (TP, SL or both) and encrypts them to the keeper keys, like the liquidator notes.
- **Execute:** a keeper sees the oracle cross a level and proves "the mark price is beyond this position's trigger"; the contract settles exactly as a normal close.
- **Merge it into `closePosition`:** the circuit accepts either the owner secret or a met trigger. A separate circuit's name would tell the public that a close was a TP/SL; one entry point hides it.
- **Payout:** unchanged. It goes to the payout key bound at open, so a keeper can trigger a close but cannot redirect the money, as with liquidation.
- **Fill price:** the oracle price at execution, not the trigger level. The oracle moves only on a 0.5% move or the hourly heartbeat, so a stop loss can fill past its level, the same gap risk as liquidation. Filling at the trigger would make the pool pay for every gap.
- **Fee:** none (decided 2026-10-10): no execution fee for stop losses and take profits.
- **Change or cancel:** one transaction (nullify the order, commit a new one), about 11 s and a little DUST.
- **Conflicts:** an execution reads the exact mark price, so it can collide with a price update; the keeper retries.

Privacy:

- The public sees neither the levels nor that a close was a TP/SL.
- The keepers see the levels, on top of the size, direction and entry they already see.

Open questions:

- Triggers inside the position commitment (changing them means re-committing the position) or a separate order commitment with its own nullifier (cheaper to change)? Leaning separate.
- A trailing stop needs the keeper to track the price high since the order was placed, and the contract to check it. Out of scope for now.

Tasks:

- [x] Contract: order commitment and note; cancel. Executed by its own circuit, `executeOrder`, for now.
- [ ] Contract: merge execution into `closePosition`. (No execution fee, by decision 2026-10-10.)
- [x] Keeper: decrypt orders, watch the oracle, execute, retry on the next tick.
- [x] Frontend: a red "Set SL" and a green "Set TP" button on each open position (Trade page row, Portfolio card), with the PnL at the level; move (place the new order, then cancel the old) and cancel; lines on the candle chart; history shows "take profit" or "stop loss". Orders are set on open positions only: inputs in the order ticket as well were tried and dropped, because two places to set them was confusing.
- [x] Tests: a stop loss and take profit fire only beyond the level; a keeper cannot place, move or fire an unmet order; the payout reaches the opener; a cancelled order cannot fire; the level is not published.
- [ ] Tests: `/check` fuzzing of the merged close circuit (both branches are evaluated in the proof).
- [ ] Re-measure the close circuit's proving-key size when merging: it is already 38.8 MB, just above the 37 MB 1AM proved, so the trigger branch must stay small (no `slice`). As its own circuit, `executeOrder` is 76.7 MB, which only the keeper proves.

## 7. Limit orders

**Contract change:** yes. A later contract version, after 3 + 4 + 6.

**Status 2026-10-09:** built in the contract (`placeLimitOrder`, `executeLimitOrder`, `cancelLimitOrder`), the core code (`core/limits.ts`, `core/perp.ts`), the keeper and the tests, and run on the devnet (`npm run limit`); deployed on preview 2026-10-10 (zkperp `a0595104…`). Frontend built 2026-10-10 (Market/Limit in the ticket, open orders on the Trade page, the chart and Portfolio, cancel, recovery from the trader's note); a limit order placed from the browser on preview was filled there by the keeper. Expiry added 2026-10-10 (contract, notes, keeper, frontend, tests; devnet `npm run limit` passed), not yet on preview. No execution fee: decided 2026-10-10, none for limit orders, stop losses or take profits. The fill takes no separate opening fee: as with `openPosition`, the fee stays in the escrowed coin and leaves at close. Proving keys: placing 10.0 MB and cancelling 19.5 MB (both fit 1AM), filling 21.6 MB (the keeper only).

Harder than step 6: opening spends the trader's collateral, and a keeper cannot spend someone else's shielded coin. So the collateral waits in the contract.

Design:

- **Place:** the trader's wallet moves the collateral into the contract as escrow, with a committed order (side, size or leverage, limit price) encrypted to the keepers.
- **Fill:** when the price crosses, a keeper proves it and turns the escrow into a position at the oracle price, which is at or better than the limit. The fill writes the position commitment and its liquidator notes, like an open, and takes the opening fee.
- **Cancel:** the owner takes the escrow back, paid to the payout key bound at placing.
- **No free slot at fill:** the fill is refused and the order waits.
- **Fee:** none (decided 2026-10-10). The keeper's costs are the protocol's.
- **Expiry:** optional; an expired order can only be cancelled. Checked against the fill's open time, so the expiry stays private.

Privacy:

- While waiting, the public sees an escrow deposit, not its side or price.
- The keepers see the order.

Costs:

- The fill circuit is about the size of the open circuit. Keepers prove it on their own servers, so 1AM's proving-key limit does not apply; placing and cancelling are small circuits the trader proves.
- Escrowed collateral is not in the pool, but it changes the contract's coin accounting; the tests must cover it.

Tasks:

- [x] Contract: escrow, order commitment and note, fill (`executeLimitOrder`), cancel. The fill publishes its entry price and open time under the order's nullifier (`limitFills`), both public anyway, so the trader can rebuild the position.
- [x] Contract: expiry (2026-10-10). No execution fee, by decision.
- [x] Keeper: watch orders, fill, retry when the slot or price moved.
- [x] Frontend: Market/Limit switch in the order ticket; open orders in Portfolio and on the chart; cancel; recovering waiting and filled orders from the trader's note (2026-10-10; to try in the browser on preview).
- [x] Tests: fills only at or better than the limit, long and short; cancel returns the escrow; a filled or cancelled order cannot be reused; a full pool makes the order wait; the keeper cannot alter the order or the payout keys; the level and size are not published.
- [ ] Tests: `/check` fuzzing.

## 8. Load test with 10 trading agents

**Contract change:** none.

So far every test has been one trader at a time, plus `npm run race`, which sends two transactions from two wallets at the same moment. On a live network many traders prove and submit at once, while the oracle updates the price and keepers liquidate. This step runs that on purpose, before anyone else does.

Agents: ten headless scripted traders, built on `core/` like `npm run demo` and `npm run race`, each with its own wallet and position key. They are bots with randomized behaviour, not language-model agents; an LLM-driven trader could be added later, but it would test the same transactions.

- **Traders:** open and close at random intervals, long and short, across leverages; some set TP/SL (step 6) and some limit orders (step 7, once it exists); a few take high leverage, so liquidations happen.
- **LPs:** two of the ten deposit and withdraw, so capacity changes while trades run.
- **Recovery:** one agent drops its local records and rebuilds them from the encrypted notes, mid-run.
- **Around them:** the relayer(s), the three keepers and the treasury run as in production.

Where:

1. **Devnet first**, with a mock price that moves fast (`npm run price`), so liquidations, TP/SL and price-update conflicts happen within minutes. The dev preset funds the ten wallets.
2. **Then preview**, after the 3 + 4 + 6 redeployment, with the real Chainlink price. Each wallet needs tNIGHT registered for DUST: fund them from one wallet rather than ten faucet visits.

What to measure, per run:

- [ ] Success rate per transaction kind, and why the failures failed: "price moved" (a price update), the pool coin taken by another close in profit (race B), capacity, DUST, timeouts.
- [ ] Time per trade, split into proving, wallet balancing and inclusion; how many retries a trade needed.
- [ ] Proof server throughput: ten agents on one proof server queue up. Measure with one and with several, to know what a keeper needs.
- [ ] Keepers: time from a position becoming liquidatable (or a trigger being met) to its close; how many keeper transactions lost a race, and what that cost in DUST.
- [ ] Treasury: fee epochs fire on schedule while trades run.
- [ ] Invariants, checked against the indexer after the run: the pool's value equals deposits, minus withdrawals, plus trader losses and LP fees, minus trader profits; no position is both open and closed; every agent's records match its notes.

Expected bottleneck: closes in profit all spend the one pool coin, so only one lands per block and the others retry (race B). The run tells how bad that is with ten traders; if it is bad, splitting the pool coin becomes a contract task.

Tasks:

- [ ] `scripts/agents.ts`: N agents, a seed per agent, a behaviour mix, a run length; logs each transaction as JSON.
- [ ] A report: success rates, times, retries, keeper latency, invariant checks.
- [ ] Wallet funding for N agents on devnet and preview.
- [ ] Run on devnet, fix what breaks, then on preview after the redeployment.

**Done when** ten agents run for an hour on preview with no invariant broken, every failure explained, and the retry rate written down.

## 9. Launch on preprod

**Contract change:** none; a fresh deployment of the version that passed step 8.

Preview is where Midnight tries new releases; it changes and resets more often. Preprod is the network meant to mirror mainnet, so it is the right place for a public testnet launch that others use for weeks.

Before deploying:

- [ ] Confirm preprod's endpoints (indexer, its websocket, node RPC), its network id and its tNIGHT faucet, and add a `preprod` network to `core/network.ts` with `setup:preprod`, `relayer:preprod`, `keeper:preprod`, `treasury:preprod` and `frontend:preprod` scripts.
- [ ] Confirm the proof server and SDK versions preprod runs, and that the contract compiles and proves with them; preview and preprod can be on different releases.
- [ ] Confirm 1AM supports preprod, and how its Local proof server setting behaves there.
- [ ] Per-role keys from step 2, generated fresh for preprod; no preview secret reused.

Deploy and run:

- [ ] `npm run setup:preprod`; seed the pool with liquidity.
- [ ] Freeze the contract's maintenance authority once every verifier key is on chain. Every deploy gets one, held by the deployer's signing key in `midnight-level-db`, and setup uses it to insert the deferred circuits' keys (`DEFERRED` in `core/session.ts`: a deploy with all 13 circuits is refused, "Transaction would exhaust the block limits"). Whoever holds that key can insert, replace or remove verifier keys, for example swap a circuit for one with other payout rules. After setup, replace the authority with `submitReplaceAuthorityTx`: an empty one, so the circuits can never change, or a multi-signer committee if upgrades should stay possible. Add a check anyone can run that shows the authority, so users can see the rules are frozen. Decide which before launch; preview keeps its authority, for testing.
- [ ] Three relayers and three keepers on separate machines, run by their operators (steps 3 and 4), plus the treasury.
- [ ] Health checks and alerts: oracle age near `maxPriceAge`, a keeper or relayer down, a treasury epoch overdue, DUST running low on any service wallet.
- [ ] Host the frontend at a public HTTPS address, with preprod's config. Check that it reaches a trader's local proof server from there (CORS was checked; Chrome may ask the trader to allow local network access).
- [ ] The Faucet page links preprod's tNIGHT faucet.

Launch:

- [ ] The preview checks again on preprod: open, close, TP/SL, liquidation, recovery on a second browser.
- [ ] A short trader guide: Docker proof server, 1AM set to Local, the password, what is private and what is not (linking `docs/privacy.md`).
- [ ] Keep preview running until preprod is stable, then retire it (close positions, let LPs withdraw).

## 10. Add collateral

**Contract change:** yes.

Lets a trader top up a position near liquidation instead of closing it. A new circuit consumes the position (its nullifier), takes a new coin, and re-creates the position with the larger collateral and a fresh liquidator note written in the circuit, as the open does. Size, side, entry price and open time carry over, so the borrow fee keeps accruing from the original open.

- [ ] Contract: `addCollateral`; the leverage and collateral checks as on open; new liquidator note(s), three once step 4 lands.
- [ ] The position's commitment changes, so its SL/TP orders no longer match: the frontend re-places them after the top-up (and cancels the old ones, returning nothing, as they hold no coin).
- [ ] Frontend: "Add collateral" on each open position, showing the new liquidation price.
- [ ] Tests: the liquidation price moves away; a liquidated or closed position cannot be topped up; only the owner can; the old commitment cannot be closed afterwards.
- [ ] Measure the circuit's proving-key size against 1AM's limit (37 MB carried).
- [ ] `/check` fuzzing (step 1b): tiny and huge top-ups, a top-up on a position already below maintenance, top-ups that bring leverage to exactly 1×, a borrow fee larger than the equity left at the time of the top-up.
- [ ] Property test (step 1a): a top-up then close settles the same as an open with the larger collateral, less nothing; the liquidation price only moves away from the mark.
- [ ] Later: increase size, the same mechanics plus the opening fee on the added size and the leverage bound.

## 11. Bracket orders

**Contract change:** none, done in the frontend first.

A limit order with a take profit and stop loss attached: set once, walk away. The frontend keeps the chosen levels with the limit order (in the trader's note) and places the TP/SL orders as soon as it sees the fill. The trader must come online after the fill for that; until then the position is unprotected, which the UI says.

- [ ] Frontend: TP/SL inputs on the Limit ticket; place them on fill; show them as pending on the order.
- [ ] Property test of the frontend's checks: random limit levels and TP/SL levels never yield a TP/SL that would fire at once on fill, nor one on the wrong side of the limit.
- [ ] Later, if the gap matters: let the keeper place them at fill (the trader pre-seals the order notes), or have `executeLimitOrder` commit them, at a proving cost to measure.

## 12. Partial close

**Contract change:** yes.

Close part of a position: settle a fraction of size and collateral, and re-create the rest as a new position (new commitment, new liquidator note, SL/TP to re-place as in step 10).

- [ ] Its own circuit, not a branch of `closePosition`, which is already 38.8 MB, just above the 37 MB 1AM proved.
- [ ] `/check` fuzzing: proofs evaluate every branch, so the split's arithmetic must stay valid in untaken branches (rounding of fees and PnL on both parts in the pool's favour).
- [ ] Tests: the two parts' settlement plus the remainder equals a full close, within rounding; the remainder's liquidation price is unchanged.
- [ ] Property test (step 1a): random sizes, fractions and prices; the two parts conserve value, and splitting never pays more than one full close.

## 13. Funding rate and per-side open interest caps

**Contract change:** yes, but write the design first.

The contract notes "Not yet here: funding." Funding, and caps on long or short exposure, both need the long/short split, and today no position's side is public: the slot counter reserves the same for either. Publishing open interest per side would reveal each open's side. The borrow fee already prices the pool's risk.

- [ ] A design note in `docs/`: what funding buys over the borrow fee for a pool-as-counterparty market; options that keep sides private (e.g. a skew the oracle relays from a reference market, or a ZK-aggregated total revealed only per epoch); what each leaks.
- [ ] Decide whether to build it before preprod; likely not.

## Running it 24/7: who proves what

Written 2026-10-09, after the first take profit executed on `preview`. Not a step of its own; it shapes steps 4, 8 and 9.

Every transaction carries zero-knowledge proofs, and a proof needs the circuit's private inputs. Who proves is therefore also who learns those inputs.

### Traders

A trader's open, close, `placeOrder` and `cancelOrder` take size, side, collateral and the owner secret as private inputs. Three places can prove them:

| Prover | What the trader needs | Who sees the private inputs |
|---|---|---|
| A proof server on the trader's own machine (Docker) | Docker running | Only the trader |
| The wallet's prover (1AM sends `/prove` to the proof server it is configured with) | Nothing extra | Whoever runs that proof server |
| A hosted proof server, run by the operator or a third party | Nothing extra | Whoever runs that proof server |

- This is the frontend's prover setting; the Privacy inspector says whether the prover is on this machine.
- A remote prover learns the position, and with the owner secret it could close it early. It cannot take the money: the payout key is bound to the wallet that opened the position, and the circuit enforces it.
- So Docker is needed for full privacy, not to trade at all. Most traders will not run Docker: a production deployment should offer a hosted prover as the default and local proving as the private option, and say plainly what each one reveals.
- The browser proves only the trader's circuits. When 1AM proves them, the proving key travels with the request, and 1AM carried 37 MB but refused 81 MB (measured 2026-10-07): `placeOrder` (10 MB) and `cancelOrder` (5.2 MB) fit easily; `closePosition` (38.8 MB) is just above what was measured to work. With a local proof server, 1AM only balances and signs, so its limit does not apply.

### Keepers

A keeper is a server running 24/7:

- the keeper service, which watches the chain and executes orders and liquidations;
- its own proof server (Docker) on the same machine;
- a wallet with NIGHT, for the DUST that pays transaction fees.

Proving locally costs a keeper no privacy: it proves with what it already decrypted from its notes. A hosted prover would only add a dependency. The relayer and the treasury job can run on the same machines.

Measured 2026-10-09 on `preview`, a take profit, keeper and proof server on one machine with 24 cores:

| Step | Took |
|---|---|
| The price update lands, and the keeper's next check (every 15 s, `KEEPER_CHECK_MS`) sees it | ~23 s |
| Eight small proofs in parallel: the transaction's coins | ~10 s |
| **The `executeOrder` proof** | **31.6 s** |
| One more small proof, submission, the block | ~18 s |

About a minute from the keeper's decision to the payout. `executeOrder` is the contract's largest circuit (76.7 MB of proving key): it does a whole close, two Merkle paths (position and order), the PnL and fees, and three payouts.

Sizing a keeper machine:

- **CPU** sets the time to execute. Expect a 4–8 core VPS to be noticeably slower than the 24 cores measured; this is the machine to spend on.
- **Memory:** the 77 MB key and the proving itself take several GB; start at 16 GB.
- **Throughput:** one keeper proves its executions one after another. A sharp move that fires many stop losses at once queues them. Several keepers on separate machines (step 4) spread that load, and cover one being down.

What would make an execution faster, by gain:

1. **A smaller `executeOrder`** (or the merged close of step 6): proving time follows circuit size. A contract change.
2. **Checking sooner:** a 3 s `KEEPER_CHECK_MS` saves up to 12 s per order at the cost of more indexer reads; reacting to each new block is better still.
3. **Proof server tuning:** workers and CPU for the Docker container; helps the parallel small proofs more than the large one.

Block time and finality are the network's.

### Who runs what in production

| Who | Runs |
|---|---|
| Trader | Browser and wallet; Docker for private proving, optionally |
| Each keeper operator | A machine with the keeper service and a proof server; also the relayer, for an oracle signer |
| The treasury | The treasury job |

No keeper is trusted with funds: an order executes only once its level is reached, a liquidation only below maintenance margin, and the payout always goes to the trader's wallet. More keepers, even run by others, add speed and availability, not risk.

Tasks:

- [ ] A hosted proof server for traders who do not run Docker, behind HTTPS, with the frontend stating that it sees their positions.
- [ ] A keeper machine spec and a deployment recipe (keeper, proof server, relayer; restart on failure; logs).
- [x] A benchmark kit that needs no chain: capture a proving request once, replay it on any machine (`bench/`, with results). On a Ryzen 9 3900X, `executeOrder` takes 67.7 s on 1 vCPU, 23.5 s on 4, 16.2 s on 8, 12.8 s on 24; it flattens past 8 vCPUs, and needs about 4 GiB per proof in flight.
- [ ] Run `bench/scale.sh` on rented candidates (Hetzner CCX, AWS c7a, GCP c3d) before choosing machines for step 9.
- [ ] Keeper: prove several executions at once on a large machine (two at once on 24 vCPUs: 8.6 s per proof instead of 12.8 s); today it executes one after another.
- [ ] Try a shorter `KEEPER_CHECK_MS`, or a block subscription, and measure the indexer load.

