# ZKPERP on Midnight

[![CI](https://github.com/hwdeboer1977/zkperp-midnight/actions/workflows/ci.yml/badge.svg)](https://github.com/hwdeboer1977/zkperp-midnight/actions/workflows/ci.yml)

Private perpetuals on [Midnight](https://midnight.network): go leveraged long or short against a GMX-style liquidity pool without publishing your position's direction, size, collateral or leverage, or linking it to your wallet.

> ⚠️ **pUSDC is a mock token. Anyone can mint any amount of it.** It exists so the devnet can hand out collateral without a faucet, and it has none of the supply control a real stablecoin needs. zkperp itself only accepts the one token it was deployed with; swapping pUSDC for a real shielded stablecoin changes nothing in zkperp's contract.
>
> The price oracle is also a mock: the admin sets the mark price. Each price carries the time the oracle observed it (for Chainlink, the round's `updatedAt`), and every open and close refuses a price older than `maxPriceAge`, which should sit just above the feed's heartbeat. A price update cannot carry an older time than the current one, so an old round can't be replayed.

## How it works

| Contract | What it is |
|---|---|
| `contracts/pusdc.compact` | pUSDC, a shielded stablecoin (6 decimals). Balances and transfers are private; only minting is public. |
| `contracts/zkperp.compact` | The pool and the positions, in one contract. Midnight contracts cannot call or read each other, so a separate pool could not settle a position. |

**The pool (GMX-style).** LPs deposit pUSDC and receive zLP shares. The pool is the counterparty to every trade: it pays out traders' profits and keeps their losses. The pool is one pUSDC coin, stored on the ledger so anyone can settle against it.

**Withdrawing.** An LP sends zLP back and receives `shares × pool / supply` pUSDC, rounded down in the pool's favour. Only liquidity that is not reserved can leave: the pool must still back every open position's `maxPayout` afterwards. The last LP may empty an idle pool completely. Redeemed zLP is retired: the contract receives it and has no circuit that can spend it.

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

**Solvency.** GMX sets aside pool funds for each position, sized by the position, so profits are always payable. Doing that here would publish every size. Instead, every position's profit is capped at one public constant, `maxPayout` (an enforced take-profit), and every open reserves exactly `maxPayout`, whatever the position's real size. The reservation reveals nothing about the position: reserved liquidity is always live positions × `maxPayout`, and the position count is already public. An open is refused unless the pool stays worth more than that, so every open position's maximum profit is always covered. LP withdrawals are held to the same rule.

The reservation is kept as a count of free **slots** of `maxPayout` each, in a `Counter`: an open checks `!freeSlots.lessThan(1)` and takes one, a close gives one back. That shape is what lets trades run concurrently; see below.

The cap is a constant rather than a multiple of collateral on purpose. A position that hits the cap is paid exactly the cap, in public, so a cap of `k × collateral` would publish the collateral every time it binds. A constant cap reveals only that it bound. The cost is capital efficiency: the pool must hold `maxPayout` for every open position.

**Custody.** The collateral coin is deliberately **not** written to the ledger, because storing a coin publishes its value, and that value is the collateral. Only the trader knows its nonce, kept in `.zkperp/positions.json`. At close, the trader names the coin and the commitment proves it is theirs. The payout goes to the wallet that opened the position: its coin key is part of the commitment (`payTo`), so whoever learns the owner secret can force a close but cannot redirect the money. **If that file is lost, the position can't be closed and its collateral is stuck.** Each entry in it is marked pending, open, closed or failed.

**Positions on any device.** The browser app also writes the opening to chain, in `openPosition`'s `note`: 128 bytes, AES-GCM-encrypted under a key derived from the trader's **password** (Argon2id, salted with the wallet account's coin key), stored in the `notes` set. The owner secret, salt and coin nonce derive from that key and a seed inside the note. On any computer, the same wallet account plus the password find every position: the app decrypts the notes and checks each nullifier against `closed`. A passkey can remember the key on one device, so the password is not typed each time. The payout goes to the wallet that opened the position, so a stolen password lets a thief force a close but not take the money. Notes are fixed-size and a close names none, so they link nothing. Why a password and not the wallet: the DApp connector exposes no seed and no decrypt, and 1AM's `signData` is randomized (measured 2026-10-02 and 2026-10-07, `frontend/public/signdata-determinism.html`). The CLI writes random bytes as its note and keeps using `positions.json`. See `core/password.ts`, `core/notes.ts` and `docs/privacy.md`.

**Liquidation.** A position whose equity falls below 2.5% of its size can be closed by a keeper without the owner secret (`liquidatePosition`). Every open writes a second note, encrypted in the circuit to the keeper's key, holding the position without the owner secret; the keeper (`npm run keeper`) decrypts these, watches the price, and liquidates. A 0.5% fee goes to the treasury, and what equity is left goes to the trader. The keeper sees every position, which is a trust assumption like the treasury's; see `docs/privacy.md`. `npm run liquidation` runs the whole path on the local stack.

**Stop loss and take profit.** The owner can attach an order to an open position (`placeOrder`): close it once the mark price reaches a level. The keeper reads the order from a note sealed to its key and executes it (`executeOrder`), settling as a normal close to the opener's wallet; the public does not see the level. `npm run stoploss` runs it on the local stack (add `--keeper` to let the running keeper service execute). See `docs/privacy.md`.

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
- **If the oracle stops, trading stops**, closes included, until a fresh price arrives. A trade at a stale price would let traders pick their price.
- **The oracle lags the market.** Chainlink publishes a new round on a 0.5% move or hourly, so the market can move up to ~0.5% before the contract's price follows, and a trader watching exchanges can trade on that. The opening and closing fees absorb most of this edge; a spread around the oracle price or a faster feed would close it.
- **Funding rates** need the long/short skew, which is private. The design for that is open (bucketed or batch-published skew are the candidates).

The privacy claims are tested, not just asserted:

- `npm test` runs every circuit locally and searches the resulting public state and transcript for each private value, with positive controls.
- `npm run probe:leak` deploys a test-only contract that publishes three amounts on purpose, and checks that the search finds them. On-chain a disclosed amount appears as a length byte (0x40 + its byte count) followed by its little-endian bytes; the search treats that form as a leak, and plain byte matches, which a short number can hit by chance in proof bytes, as warnings to review. This shows which encodings the search covers, so a "not found" elsewhere can be trusted for those encodings.
- `npm run demo` searches the raw bytes of every trade transaction on the devnet.

**Concurrent trades.** A Midnight transaction is proven against the state it read, and fails if a value it read *exactly* has changed by the time it lands. `npm run probe:race` measures which ledger operations conflict: exact reads of a changed cell do; `Counter` increments, decrements and `lessThan` checks, Merkle and set inserts, and historic root checks do not. zkperp is laid out on that basis, and `npm run race` checks it on zkperp itself:

| Race | Outcome | Why |
|---|---|---|
| Two opens | both land | each takes a slot with a `lessThan` check and a decrement |
| Two closes at an unchanged price | both land | neither reads the pool coin or its value |
| A trade against a price update | the trade fails and is proven again | **by design**: pricing is strict, so a trade settles at the latest price or not at all. The oracle relayer updates only on a new Chainlink round |
| Two closes that move the pool | one lands, the other must retry | both spend the one pool coin. The rejection is free; the frontend retries |

**Local tests are not enough for Compact.** The zero-knowledge proof evaluates every branch of an `if`; only the taken branch's effects are kept. The JavaScript runtime that local tests use runs only the taken branch. A value that goes negative in an untaken branch still breaks the proof. The first loss close on the devnet failed this way, while every local test passed (see the note in `closePosition`). So `npm run demo` runs every settlement path through the real proof server, for a long and for a short: flat, profit, loss, profit larger than the collateral, wipe-out, and capped profit.

## Layout

```
contracts/           Compact sources: zkperp, pusdc, and test-only probes in probe/
core/                shared TypeScript: wallets, providers, contract calls, fee and PnL
                     maths, position records, the Chainlink reader, the privacy search
services/oracle/     the price relayer: Chainlink ETH/USD → setPrice, on each new round
services/treasury/   the fee-epoch job: pays the LPs' share of fees into the pool
scripts/             dev tooling: the devnet demo, the race tests, the probes, local setup
test/                circuit tests, run locally without a chain
frontend/            the browser app, its own package: Vite + React, 1AM or Lace
```

The liquidator will get its own service in `services/liquidator/`.

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
npm run race            # concurrent trades against each other and the oracle
npm run probe:race      # which ledger operations conflict (npm run compile:probe first)
```

`npm run demo` uses the devnet's pre-funded dev wallet as deployer, LP and oracle, plus a **separate trader wallet** that it funds on first run. It:
- opens and closes a long and a short at an unchanged price, where the collateral must come back less exactly the three fees, and the treasury must receive exactly those fees;
- closes one long and one short through each of the other settlement paths, where the trader, the treasury and the pool must each move by exactly the settled amount, and the pool by the PnL alone;
- has the treasury pay 70% of the run's fees into the pool, raising the value of each zLP share;
- checks that every open reserves exactly `maxPayout` and every close releases it;
- redeems part of the LP's zLP, is refused emptying the pool while a position is open, then empties it once nothing is open (the next run deposits again);
- runs the privacy search on every trade transaction.

`npm run devnet:reset` wipes the chain and all local state.

### The local stack

The services and the frontend run against the same devnet, with the real Chainlink feed. Put an Ethereum mainnet RPC URL in `.env` as `EVM_RPC_URL`; reading the feed needs no key or gas.

```sh
npm run setup:local     # fresh zkperp priced by Chainlink, a funded pool, trader, treasury and keeper wallets
npm run relayer         # terminal 1: submits each new Chainlink round   (health: :3010/health)
npm run treasury        # terminal 2: runs fee epochs, ≥5 closes and ≥1 hour apart   (:3011/health, /epochs)
npm run keeper          # terminal 3: liquidates positions below maintenance margin
```

Then the frontend, in a third terminal:

```sh
(cd frontend && npm install)   # once
npm run frontend               # copies contracts, keys and config into frontend/, serves http://localhost:5173
npm run fund -- mn_addr_undeployed1…   # sends NIGHT to your browser wallet, for DUST
```

Set the wallet to the **Undeployed** network. Every trade is proven by a proof server, which sees the trade's size, direction and collateral. The app uses the one on this machine (`npm run proof:up`) and lets the wallet only add fees and sign; if that one is down when you connect, 1AM proves on the one in its own network settings. The wallet button shows which one is in use, in red if it is not local. Mint pUSDC on the Faucet page, unlock your position key with a password (or generate a passphrase the first time), and trade. Positions opened with it show up on any computer where you connect the same wallet account and enter the password. See `docs/privacy.md`. The encrypted backup on the Portfolio page is still there for positions opened without a key.

After `npm run frontend:config` (or a recompile), restart the dev server: a running one keeps serving the old circuit files' list and answers new ones with HTML, which the wallet reports as "Proof server check failed (400): bad input".

`setup:local` writes `.zkperp/local-stack.json` with the addresses, endpoints and the treasury's keys. Don't run `npm run demo` or `npm run race` while the relayer runs: they set mock prices of their own.

### The preview testnet

The same stack runs on Midnight's public `preview` network; the scripts and services pick it with `ZKPERP_NETWORK=preview`, which the `:preview` npm scripts set. The proof server stays on this machine (`npm run proof:up`): it sees every trade's private inputs.

1. Put a fresh, secret 64-hex `WALLET_SEED_PREVIEW` in `.env` (per network, so it does not replace the devnet's seed). This is the **operator** wallet: it deploys, submits prices, adds the first liquidity and funds the treasury and keeper. Traders, you included, use their own 1AM accounts in the browser; keep the two apart, since the operator wallet's transactions are public. On the devnet the dev seed is public; here it controls the oracle, the liquidator key and every derived wallet, and the scripts refuse to run without it.
2. Run `npm run setup:preview`. The first run stops with the dev wallet's address: get tNIGHT for it at <https://midnight-tmnight-preview.nethermind.dev/>, then run it again. It registers the NIGHT for DUST, funds the trader, treasury and keeper wallets with `NIGHT_PER_WALLET` (default 100 NIGHT each), deploys pUSDC and zkperp, adds liquidity, and writes `.zkperp/preview-stack.json`.
3. Run `npm run relayer:preview`, `npm run treasury:preview` and `npm run keeper:preview`, each in its own terminal.
4. Run `npm run frontend:preview`, and set 1AM to its Preview network. Check that the wallet button shows a prover on this machine: in red, the local proof server did not answer and 1AM's hosted prover, which sees your positions, is in use.

The devnet tools (`demo`, `race`, the probes, `fund`, `liquidation`, `stoploss`) refuse to run against `preview`.

## Not built yet

Funding rates. Funding needs the long/short skew, which is private; it is listed as a known limit above.
