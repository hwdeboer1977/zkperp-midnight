# ZKPERP on Midnight

Private perpetuals on [Midnight](https://midnight.network): trade a leveraged long against a GMX-style liquidity pool without publishing your position's size, collateral or leverage, or linking it to your wallet.

> ⚠️ **pUSDC is a mock token. Anyone can mint any amount of it.** It exists so the devnet can hand out collateral without a faucet, and it has none of the supply control a real stablecoin needs. zkperp itself only accepts the one token it was deployed with; swapping pUSDC for a real shielded stablecoin changes nothing in zkperp's contract.
>
> The price oracle is also a mock: the admin sets the mark price.

## How it works

| Contract | What it is |
|---|---|
| `contracts/pusdc.compact` | pUSDC, a shielded stablecoin (6 decimals). Balances and transfers are private; only minting is public. |
| `contracts/zkperp.compact` | The pool and the positions, in one contract. Midnight contracts cannot call or read each other, so a separate pool could not settle a position. |

**The pool (GMX-style).** LPs deposit pUSDC and receive zLP shares. The pool is the counterparty to every trade: it pays out traders' profits and keeps their losses. The pool is one pUSDC coin, stored on the ledger so anyone can settle against it.

**Opening a long.** The trader sends a pUSDC collateral coin to the contract and chooses a size (1×–50× the collateral). The contract appends a **commitment** to the `positions` Merkle tree: a hash of the size, collateral, entry price, the collateral coin's nonce, the owner's key and a random salt. The leverage bounds are checked inside the zero-knowledge proof.

**Closing.** The trader proves that one of the commitments in the tree is theirs without saying which one, and publishes a **nullifier**, a one-time tag that prevents a second close and can't be linked back to the commitment. The contract then:
- **Profit:** returns the whole collateral plus the profit, paid from the pool.
- **Partial loss:** returns the collateral minus the loss; the loss is merged into the pool.
- **Loss of the whole collateral:** merges all of it into the pool; nothing comes back.

Circuits can't divide, so the trader supplies the PnL and the circuit checks it is exactly `size × Δprice / entry`, rounded in the pool's favour.

**Solvency.** GMX sets aside pool funds for each position, sized by the position, so profits are always payable. Doing that here would publish every size. Instead, every position's profit is capped at one public constant, `maxPayout` (an enforced take-profit), and every open reserves exactly `maxPayout`, whatever the position's real size. The reservation reveals nothing about the position: `reserved` is always live positions × `maxPayout`, and the position count is already public. An open is refused unless `reserved` stays below the pool's value, so every open position's maximum profit is always covered.

The cap is a constant rather than a multiple of collateral on purpose. A position that hits the cap is paid exactly the cap, in public, so a cap of `k × collateral` would publish the collateral every time it binds. A constant cap reveals only that it bound. The cost is capital efficiency: the pool must hold `maxPayout` for every open position.

**Custody.** The collateral coin is deliberately **not** written to the ledger, because storing a coin publishes its value, and that value is the collateral. Only the trader knows its nonce, kept in `.zkperp/positions.json`. At close, the trader names the coin and the commitment proves it is theirs. **If that file is lost, the position can't be closed and its collateral is stuck.** Each entry in it is marked pending, open, closed or failed.

## What is public, and what is not

| Public | Private |
|---|---|
| Pool liquidity and zLP supply, and so each LP deposit | A position's size, collateral and leverage |
| Reserved liquidity: live positions × `maxPayout` | |
| The mark price, and so the entry price of anything opened at it | Who owns a position: the owner is a hash of a per-position secret, not a wallet key |
| That a position opened or closed, and when | Which open a close belongs to |
| **At close: the PnL**, as the pool's change | The payout recipient's key |

Known limits:

- **PnL at close.** The pool's balance change equals the PnL. Opens and closes are unlinkable, but an observer who guesses the entry price from the price history can narrow the size to a few candidates. A close at an unchanged price reveals nothing.
- **Wipe-outs publish the collateral**, since all of it moves into the pool.
- **A capped profit shows that the cap bound**, which means `size × Δprice / entry ≥ maxPayout`.
- **Funding rates** need the long/short skew, which is private. The design for that is open (bucketed or batch-published skew are the candidates).

The privacy claims are tested, not just asserted:

- `npm test` runs every circuit locally and searches the resulting public state and transcript for each private value, with positive controls.
- `npm run probe:leak` deploys a test-only contract that publishes three amounts on purpose, and checks that the search finds them. On-chain they appear as little-endian bytes. This shows which encodings the search covers, so a "not found" elsewhere can be trusted for those encodings.
- `npm run demo` searches the raw bytes of every trade transaction on the devnet.

**Local tests are not enough for Compact.** The zero-knowledge proof evaluates every branch of an `if`; only the taken branch's effects are kept. The JavaScript runtime that local tests use runs only the taken branch. A value that goes negative in an untaken branch still breaks the proof. The first loss close on the devnet failed this way, while every local test passed (see the note in `closeLong`). So `npm run demo` runs every settlement path through the real proof server: flat, profit, loss, profit larger than the collateral, wipe-out, and capped profit.

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
- opens and closes a long at an unchanged price, where the collateral must come back in full;
- closes one long through each of the other settlement paths, where the trader and the pool must each move by exactly the settled amount;
- checks that every open reserves exactly `maxPayout` and every close releases it;
- runs the privacy search on every trade transaction.

`npm run devnet:reset` wipes the chain and all local state.

## Not built yet

Liquidation, shorts, fees, funding rates and LP withdrawal. LP withdrawal must keep the solvency invariant: it can only take out what is not reserved.
