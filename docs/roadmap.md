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

Steps 3, 4 and 6 change the contract, so they ship together in **one** redeployment. Step 7 is a later contract version of its own. Step 1 comes first, so those changes land on a safety net. Step 8 then tests the new version under load, and step 9 launches it on preprod.

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

## 3 + 4 + 6. One redeployment

- [ ] Ship steps 3, 4 and 6 in one contract version.
- [ ] Run `npm test`, the `/check` fuzzer, `npm run demo` and `npm run liquidation` on the devnet.
- [ ] Before redeploying `preview`: close open positions on the old deployment, and let LPs withdraw. There is no upgrade path; the new contract has new addresses, a new pool and a new pUSDC token.
- [ ] `npm run setup:preview` with the per-role keys from step 2; start three relayers and three keepers.
- [ ] Re-run the preview checks: open, close, liquidation (with `npm run price:preview`, which in 2-of-3 needs two signers), a take profit and a stop loss, recovery on a second browser.

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
- **Fee:** a small execution fee from the position to the keeper that executes, like the liquidation fee in step 4.
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
- [ ] Contract: merge execution into `closePosition`; execution fee to the keeper.
- [x] Keeper: decrypt orders, watch the oracle, execute, retry on the next tick.
- [x] Frontend: a red "Set SL" and a green "Set TP" button on each open position (Trade page row, Portfolio card), with the PnL at the level; move (place the new order, then cancel the old) and cancel; lines on the candle chart; history shows "take profit" or "stop loss". Orders are set on open positions only: inputs in the order ticket as well were tried and dropped, because two places to set them was confusing.
- [x] Tests: a stop loss and take profit fire only beyond the level; a keeper cannot place, move or fire an unmet order; the payout reaches the opener; a cancelled order cannot fire; the level is not published.
- [ ] Tests: the execution fee reaches the keeper; `/check` fuzzing of the merged close circuit (both branches are evaluated in the proof).
- [ ] Re-measure the close circuit's proving-key size when merging: it is already 38.8 MB, just above the 37 MB 1AM proved, so the trigger branch must stay small (no `slice`). As its own circuit, `executeOrder` is 76.7 MB, which only the keeper proves.

## 7. Limit orders

**Contract change:** yes. A later contract version, after 3 + 4 + 6.

Harder than step 6: opening spends the trader's collateral, and a keeper cannot spend someone else's shielded coin. So the collateral waits in the contract.

Design:

- **Place:** the trader's wallet moves the collateral into the contract as escrow, with a committed order (side, size or leverage, limit price) encrypted to the keepers.
- **Fill:** when the price crosses, a keeper proves it and turns the escrow into a position at the oracle price, which is at or better than the limit. The fill writes the position commitment and its liquidator notes, like an open, and takes the opening fee.
- **Cancel:** the owner takes the escrow back, paid to the payout key bound at placing.
- **No free slot at fill:** the fill is refused and the order waits.
- **Fee:** an execution fee to the filling keeper.
- **Expiry:** optional; an expired order can only be cancelled.

Privacy:

- While waiting, the public sees an escrow deposit, not its side or price.
- The keepers see the order.

Costs:

- The fill circuit is about the size of the open circuit. Keepers prove it on their own servers, so 1AM's proving-key limit does not apply; placing and cancelling are small circuits the trader proves.
- Escrowed collateral is not in the pool, but it changes the contract's coin accounting; the tests must cover it.

Tasks:

- [ ] Contract: escrow, order commitment and note, `fillOrder`, cancel, expiry.
- [ ] Keeper: watch orders, fill, retry when the slot or price moved.
- [ ] Frontend: Market/Limit switch in the order ticket; open orders in Portfolio and on the chart; cancel.
- [ ] Tests: fills only at or better than the limit; cancel returns the escrow; a filled or cancelled order cannot be reused; capacity refusals; `/check` fuzzing.

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
- [ ] Three relayers and three keepers on separate machines, run by their operators (steps 3 and 4), plus the treasury.
- [ ] Health checks and alerts: oracle age near `maxPriceAge`, a keeper or relayer down, a treasury epoch overdue, DUST running low on any service wallet.
- [ ] Host the frontend at a public HTTPS address, with preprod's config. Check that it reaches a trader's local proof server from there (CORS was checked; Chrome may ask the trader to allow local network access).
- [ ] The Faucet page links preprod's tNIGHT faucet.

Launch:

- [ ] The preview checks again on preprod: open, close, TP/SL, liquidation, recovery on a second browser.
- [ ] A short trader guide: Docker proof server, 1AM set to Local, the password, what is private and what is not (linking `docs/privacy.md`).
- [ ] Keep preview running until preprod is stable, then retire it (close positions, let LPs withdraw).

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

