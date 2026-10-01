# ZKPERP on Midnight

Private perpetuals on [Midnight](https://midnight.network): go leveraged long or short against a GMX-style liquidity pool without publishing your position's direction, size, collateral or leverage, or linking it to your wallet.

> ⚠️ **pUSDC is a mock token. Anyone can mint any amount of it.** It exists so the devnet can hand out collateral without a faucet, and it has none of the supply control a real stablecoin needs. zkperp itself only accepts the one token it was deployed with; swapping pUSDC for a real shielded stablecoin changes nothing in zkperp's contract.
>
> The price oracle is also a mock: the admin sets the mark price.

## How it works

| Contract | What it is |
|---|---|
| `contracts/pusdc.compact` | pUSDC, a shielded stablecoin (6 decimals). Balances and transfers are private; only minting is public. |
| `contracts/zkperp.compact` | The pool and the positions, in one contract. Midnight contracts cannot call or read each other, so a separate pool could not settle a position. |

**The pool (GMX-style).** LPs deposit pUSDC and receive zLP shares. The pool is the counterparty to every trade: it pays out traders' profits and keeps their losses. The pool is one pUSDC coin, stored on the ledger so anyone can settle against it.

**Withdrawing.** An LP sends zLP back and receives `shares × pool / supply` pUSDC, rounded down in the pool's favour. Only liquidity that is not reserved can leave: the pool must stay worth more than `reserved` afterwards. The last LP may empty an idle pool completely. Redeemed zLP is retired: the contract receives it and has no circuit that can spend it.

**Opening a position.** The trader sends a pUSDC collateral coin to the contract and chooses a direction (long or short) and a size (1×–20× the collateral, net of the opening fee). The contract appends a **commitment** to the `positions` Merkle tree: a hash of the direction, size, collateral, entry price, the collateral coin's nonce, the owner's key and a random salt. The leverage bounds are checked inside the zero-knowledge proof. Longs and shorts open through the same circuit, so an open does not reveal which one it is: its public footprint differs only in the commitment.

**Closing.** The trader proves that one of the commitments in the tree is theirs without saying which one, and publishes a **nullifier**, a one-time tag that prevents a second close and can't be linked back to the commitment. The contract then splits the collateral coin:
- **Profit:** the collateral less fees back to the trader, plus the profit, paid from the pool.
- **Partial loss:** the collateral less the loss and fees back; the loss is merged into the pool.
- **Loss of the whole collateral:** all of it is merged into the pool; nothing comes back, and the closing and borrow fees are forgiven.

A long profits when the price rose, a short when it fell. Circuits can't divide, so the trader supplies the PnL and the circuit checks it is exactly `size × |Δprice| / entry`, rounded in the pool's favour.

**Fees.** Three fees, each a fraction of size, rounded up so that rounding never favours the trader:

| Fee | Amount | When |
|---|---|---|
| Opening | 0.10% of size | Taken out of the collateral coin at open; the position's collateral is what remains |
| Closing | 0.10% of size | Taken out of the payout at close |
| Borrow | size × rate × seconds held | At close; a flat rate, set at deploy |

The rates are deploy-time parameters. As with PnL, the trader supplies each fee and the circuit pins it exactly. Circuits can't read the clock, only compare against it, so the trader names the open and close times. The circuit refuses a time in the future or more than `clockSlack` seconds old, which bounds the borrow fee a trader can dodge by backdating the close.

A fee is a fixed fraction of size, so a fee paid into the public pool would publish the size. Fees therefore go to a **treasury** wallet as shielded outputs: the public sees neither amounts nor recipient, and the pool's change at a close is the PnL alone. The treasury pays the LPs' share (70% in the demo) into the pool once per epoch with `depositFees`, which mints no shares, so each zLP share gains value. Only epoch totals become public.

> ⚠️ **The treasury is trusted.** Whoever holds its key sees every fee, and so every position's size, and holds the LPs' share until it deposits it. The contract can't enforce the deposit or the LP/protocol split, because it never sees the fees.

If the closing and borrow fees exceed what the loss left of the collateral, the treasury gets what there is; the rest is taken from a profit and stays in the pool, or is forgiven.

**Solvency.** GMX sets aside pool funds for each position, sized by the position, so profits are always payable. Doing that here would publish every size. Instead, every position's profit is capped at one public constant, `maxPayout` (an enforced take-profit), and every open reserves exactly `maxPayout`, whatever the position's real size. The reservation reveals nothing about the position: `reserved` is always live positions × `maxPayout`, and the position count is already public. An open is refused unless `reserved` stays below the pool's value, so every open position's maximum profit is always covered. LP withdrawals are held to the same rule.

The cap is a constant rather than a multiple of collateral on purpose. A position that hits the cap is paid exactly the cap, in public, so a cap of `k × collateral` would publish the collateral every time it binds. A constant cap reveals only that it bound. The cost is capital efficiency: the pool must hold `maxPayout` for every open position.

**Custody.** The collateral coin is deliberately **not** written to the ledger, because storing a coin publishes its value, and that value is the collateral. Only the trader knows its nonce, kept in `.zkperp/positions.json`. At close, the trader names the coin and the commitment proves it is theirs. **If that file is lost, the position can't be closed and its collateral is stuck.** Each entry in it is marked pending, open, closed or failed.

## What is public, and what is not

| Public | Private |
|---|---|
| Pool liquidity and zLP supply, and so each LP deposit and withdrawal | A position's size, collateral and leverage |
| Each epoch's fee deposit to LPs | Each fee, and so each trade's fees (the treasury sees them) |
| A position's open time, and its close time | |
| | A position's direction, at open |
| Reserved liquidity: live positions × `maxPayout` | |
| The mark price, and so the entry price of anything opened at it | Who owns a position: the owner is a hash of a per-position secret, not a wallet key |
| That a position opened or closed, and when | Which open a close belongs to |
| **At close: the PnL**, as the pool's change | The payout recipient's key |

Known limits:

- **PnL at close.** The pool's balance change equals the PnL. Opens and closes are unlinkable, but an observer who guesses the entry price from the price history can narrow the size to a few candidates. A close at an unchanged price reveals nothing.
- **Direction at close.** Whether the pool paid or gained, together with the public price move, shows whether the position was a long or a short. A close at an unchanged price does not.
- **Wipe-outs publish the collateral**, since all of it moves into the pool.
- **A capped profit shows that the cap bound**, which means `size × Δprice / entry ≥ maxPayout`.
- **Fees reveal size to the treasury.** See the warning above.
- **Funding rates** need the long/short skew, which is private. The design for that is open (bucketed or batch-published skew are the candidates).

The privacy claims are tested, not just asserted:

- `npm test` runs every circuit locally and searches the resulting public state and transcript for each private value, with positive controls.
- `npm run probe:leak` deploys a test-only contract that publishes three amounts on purpose, and checks that the search finds them. On-chain they appear as little-endian bytes. This shows which encodings the search covers, so a "not found" elsewhere can be trusted for those encodings.
- `npm run demo` searches the raw bytes of every trade transaction on the devnet.

**Local tests are not enough for Compact.** The zero-knowledge proof evaluates every branch of an `if`; only the taken branch's effects are kept. The JavaScript runtime that local tests use runs only the taken branch. A value that goes negative in an untaken branch still breaks the proof. The first loss close on the devnet failed this way, while every local test passed (see the note in `closePosition`). So `npm run demo` runs every settlement path through the real proof server, for a long and for a short: flat, profit, loss, profit larger than the collateral, wipe-out, and capped profit.

## Running it

Requires Docker, Node 22 and the Compact compiler (`compact` 0.31.1).

```sh
npm install
npm run proof:up        # proof server on :6300, once
npm run devnet:up       # node on :9944, indexer on :8088
npm run compile         # contracts + proving keys (~1 min)
npm test                # circuit rules + privacy sweep, no chain needed
npm run demo            # full lifecycle on the devnet, two wallets
npm run probe:leak      # check the privacy search's coverage
```

`npm run demo` uses the devnet's pre-funded dev wallet as deployer, LP and oracle, plus a **separate trader wallet** that it funds on first run. It:
- opens and closes a long and a short at an unchanged price, where the collateral must come back less exactly the three fees, and the treasury must receive exactly those fees;
- closes one long and one short through each of the other settlement paths, where the trader, the treasury and the pool must each move by exactly the settled amount, and the pool by the PnL alone;
- has the treasury pay 70% of the run's fees into the pool, raising the value of each zLP share;
- checks that every open reserves exactly `maxPayout` and every close releases it;
- redeems part of the LP's zLP, is refused emptying the pool while a position is open, then empties it once nothing is open (the next run deposits again);
- runs the privacy search on every trade transaction.

`npm run devnet:reset` wipes the chain and all local state.

## Not built yet

Liquidation and funding rates. Funding needs the long/short skew, which is private; it is listed as a known limit above.
