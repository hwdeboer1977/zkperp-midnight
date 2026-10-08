# Positions on any device: design notes

This file records the decision, made on 2026-10-07, on how a trader can find and close their positions from any computer, and why the other options were dropped. The README covers what the chain sees in general. This file covers who can close a position, and with what.

## The goal

A trader should be able to manage their positions with **their 1AM wallet plus something they know**, on any computer, with nothing carried over from the old one.

## Why this is hard

A position exists on chain only as a commitment, a hash of its opening: owner key, direction, size, collateral, fees, entry price, open time, collateral coin nonce, salt and payout key. To close it, the trader must present every one of those fields. None of them can be read from the chain; that is the privacy property. So the opening has to live somewhere, and whatever unlocks it has to be reproducible on a new device.

Since 2026-10-02 the opening lives on chain, encrypted, in the contract's `notes` set: 128 bytes per position, AES-GCM, bound to the contract address (`core/notes.ts`). The owner secret, salt and coin nonce derive from a 32-byte **root** plus a random seed stored in the note. So the question reduces to one thing: **where does the root come from?**

## Options considered

| Source of the root | Any device? | Verdict |
|---|---|---|
| A local file (`.zkperp/positions.json`, browser storage, encrypted backup) | No | Kept for the CLI only |
| A signature from the wallet | Would be, if signatures were deterministic | **Rejected:** 1AM signatures are randomized |
| Passkey (WebAuthn PRF) | Only where the passkey syncs, on one domain | Built 2026-10-02; becomes a convenience option |
| Receipt token per position | Data still needs a key | **Rejected** |
| Recovery code (QR or text of the root) | Yes | Superseded by the password |
| **Password, with the wallet address as salt** | **Yes** | **Chosen** |

### Wallet signature: measured, does not work

The idea was `root = H(sign_wallet("zkperp position key v1 | <contract>"))`. That only works if signing the same message always gives the same signature.

The 1AM DApp connector (api 4.0.0) exposes no seed and no decrypt, and `signData` is randomized. This has been measured three times: polisZK on `preview` (2026-08-26), and here on `undeployed` (2026-10-02 and 2026-10-07). The probe page is `frontend/public/signdata-determinism.html`.

The 2026-10-07 run signed `zkperp/position-key-root/v1` three times. Each request used a different encoding, because 1AM refuses an identical repeated request as a "duplicate":

| # | Encoding | Signature |
|---|---|---|
| 1 | text | `0e26ca8374a7…b15decf5` |
| 2 | hex | `f7f2a511fa3d…6274320a` |
| 3 | base64 | `addeedd886bd…67bec7c8` |

- **All three are valid over the same bytes.** Checked with compact-runtime's `verifySignature` against `midnight_signed_message:27:zkperp/position-key-root/v1`.
- **The run is sound.** The verifying key stayed the same, and a control message gave different signatures.

Same bytes and different signatures means randomized signing, so no reproducible key can come from 1AM. Re-run the probe after a 1AM update.

### Passkey (built 2026-10-02)

The root is the output of the passkey's WebAuthn PRF (`frontend/src/lib/positionKey.ts`). It works, but it has limits:

- **One domain.** A passkey belongs to one site, so `localhost`, `preview` and production each need their own.
- **PRF support needed.** The authenticator must support it: Google Password Manager, iCloud Keychain and phones do.
- **Must sync.** The passkey has to sync between devices; a security key that doesn't sync only works where it's plugged in.
- **One passkey only.** A second passkey is a second root, and positions opened under one aren't found by the other.

### Receipt tokens: rejected

The idea: at open, mint a unique shielded token to the trader's wallet; a close must spend it. Spending it would prove ownership, so a leaked key could not close.

The mechanism itself is sound. The project already uses it for zLP shares: `removeLiquidity` names only the token type, and the wallet's balancing supplies the coin. 1AM also lists contract-minted tokens in `getShieldedBalances`. It was rejected for three reasons:

- **Clutter.** Each position adds a token type to the wallet, so an active trader collects hundreds of them.
- **Linking.** One token type per trader would avoid the clutter but link all of that trader's positions (see DarkStake below).
- **It doesn't solve recovery.** The position data still needs a key.

Payout binding (below) gives most of the theft protection without any tokens.

### What other teams do

All 165 submissions to the Akindo Midnight buildathon (wave-hack `jaMZjqPOBsLXvjdG`) were checked on 2026-10-07:

- **No wallet-derived keys.** No team derives a key from a Midnight wallet. Mandate uses a Keplr (Cosmos) signature; CED Shield found Lace's `signData` unimplemented.
- **Common patterns:**
  - localStorage only;
  - passphrase-encrypted export with PBKDF2 at 600k iterations plus AES-GCM (zkTicket, VEILOS, Eclipse Poll);
  - an encrypted backup on chain (lumaPay);
  - a backend that stores only ciphertext (lunarviel).
- **Closest to ours:** Midnight Pool uses WebAuthn PRF plus a QR code for recovery.
- **A lesson from DarkStake:** a per-owner tag on each position linked one trader's positions, so their sizes could be added up. Privacy is about what an observer can correlate, not about single fields.

## The overall choice: private positions

On Midnight there are two coherent designs. Which one fits depends on one question: must the position data itself be private, or is it enough that nobody knows who holds it?

| | **Private positions (chosen)** | Public positions, anonymous owner |
|---|---|---|
| Position data | Encrypted notes; one commitment per position | Public state, keyed by position id |
| Authorization | Owner secret derived from the password root | A receipt token per position, spent at close |
| Liquidation | A second note, encrypted in-circuit to the keeper | Anyone reads the public data |
| Recovery | Wallet recovery phrase plus password | Wallet recovery phrase only |
| Cost | A password to remember; a trusted keeper; larger open proofs | Sizes, entries and leverage visible; wallet clutter |

We chose private positions (decided 2026-10-07). Private position data is the point of ZKPerp, and it matches the Aleo version. Public positions would be a different and weaker product. It also has a market risk: with every size, entry and leverage public, everyone can compute everyone's liquidation price, which invites traders to push the price toward those levels.

Three changes to the proposal as first written:

- **No limit of one long and one short.** That limit comes from the Aleo design. Here each position has its own note, commitment and nullifier, and recovery handles any number of them. Increasing or partly closing a position is not supported yet.
- **The nullifier is `H(salt)`, not `H(ownerSecret, salt)`.** A liquidation has to retire a position without the owner secret. The close circuit still checks `ownerKey(ownerSecret)`; that check is simply absent from liquidation.
- **The liquidator note is encrypted inside the circuit.** It uses ECDH on Midnight's built-in Jubjub curve plus Poseidon masks, so the trader cannot hand the keeper a false copy. See section 4.

## Decision

1. **Payout binding** (built 2026-10-07). The opening wallet's coin key is part of the commitment, and a close pays only that key.
2. **Password as the primary root** (built 2026-10-07). The wallet account's coin key acts as the salt, and Argon2id makes guessing expensive.
3. **Passkey as a convenience** (built 2026-10-07). It stores the password-derived root, encrypted, on one device, so the trader doesn't type the password each time.
4. **Liquidation without the owner secret** (built 2026-10-07). A keeper liquidates using the liquidator note; any leftover equity goes to `payTo`.

### 1. Payout binding

`Position` has a field `payTo: ZswapCoinPublicKey`. `openPosition` sets it to `ownPublicKey()`, the coin key of the opening wallet. `closePosition` has no recipient argument any more; it pays `position.payTo`.

So knowing the owner secret, whether from a stolen password, passkey or file, lets an attacker **force a close but not take the money**. Both the collateral and any profit go to the opening wallet. Tests in `test/zkperp.test.mjs`:

- **A close by another wallet still pays the opener.** The closing wallet gets nothing.
- **A close cannot name another payout key.** Changing `payTo` changes the commitment, and the close fails with "path is for a different position".
- **The payout key never appears on chain.** It isn't in the open's state or transcript, nor in the close's.

The consequence: a position must be closed from the same wallet account, possibly on another device, for the payout to show up in the connected wallet. When recovering from notes, the app rebuilds each commitment with the connected wallet's key and skips notes whose commitment isn't in the tree, because those were opened from another wallet.

### 2. Password root

Built in `core/password.ts`:

```
saltKDF = SHA-256("zkperp/password-salt/v1" ‖ coin public key)   public, one per wallet account
root    = Argon2id(password, saltKDF), 64 MiB, 3 passes, 1 lane   memory-hard, slow on purpose
keys    = HKDF(root) → note key, secrets key                      core/notes.ts, unchanged
per position: ownerSecret, salt, coinNonce = HMAC(secrets key, label ‖ seed)
```

- **The salt is the coin public key**, the same 32 bytes as `payTo`. It is stable per account and network and available both in the browser (from the DApp connector) and in the CLI.
- **The password is normalized (NFKC)**, so it gives the same bytes on any keyboard or operating system.
- **Argon2id comes from `hash-wasm`**, because WebCrypto has none. It takes about 0.25 s per guess in Node and somewhat more in a browser. A fixed test value (`test/password.test.mjs`) was checked against a second implementation, `@noble/hashes`. Changing the parameters or the salt label would hide every position opened before.
- **The app generates a passphrase** of 6 words from the BIP-39 English list, joined with dashes: 66 bits. The dashes make it look different from a wallet recovery phrase, which it is not. Typed passwords need at least 16 characters and 6 distinct characters.
- **A wrong password does not fail.** It unlocks a different, empty key, so the UI says so when no positions appear.

Three different values are often called "salt", and they must not be mixed up:

| Value | Public? | Scope | Job |
|---|---|---|---|
| `saltKDF` (from the coin key) | Yes | One per wallet account | Stops one precomputed table from cracking every user; adds no secrecy |
| Position `salt` (from root + seed) | **No** (the keeper knows it) | One per position | Hides the commitment; it is the nullifier's input |
| `payTo` (coin key) | Inside the commitment only | One per wallet account | Where a close pays |

Using the public address as the position salt would break three things at once:

- **Nullifiers become predictable.** Anyone could compute them, so every close would show which wallet it came from.
- **One position per wallet.** The same salt gives the same nullifier, so after the first close no new position could open.
- **The commitment stops hiding anything.** Its other fields have little entropy, so they could be guessed.

**Threat: offline guessing.** Anyone can download every note. To attack a known account, they derive a root for each guessed password and try to decrypt. The defences are the memory-hard KDF, the generated passphrase, and payout binding: a cracked password lets the attacker force closes, but the money still goes to the trader's wallet.

**Other consequences:**

- **No password change.** The password is part of every open position. A new password applies only to new positions; old ones close under the old one.
- **A lost password means the trader cannot close.** There is no reset. If the price later makes the position liquidatable, the keeper releases what equity is left to `payTo`.
- **Tied to account and network.** Another 1AM account or network gives another `saltKDF`, so it finds no positions. The UI shows which account the key is unlocked for.

### 3. Passkey as a convenience

`frontend/src/lib/positionKey.ts`. After the password unlocks the key, "Remember on this device with a passkey" does the following:

1. It creates a passkey and derives an AES-GCM key from the passkey's PRF output.
2. It encrypts the root with that key, using the coin key as associated data, and stores the result in this browser's storage.
3. Next time, a tap on "Unlock with passkey" decrypts the root.

Losing the passkey or the browser storage loses nothing, because the password still works. So the passkey's limits (one domain, PRF support needed) no longer matter. The unlocked key is bound to the account it was derived for, and reads as locked while another account is connected.

### 4. Liquidation without the owner secret

**What changed in the contract:**

- **New constructor parameters:** `maintenanceBps`, `liquidationFeeBps`, and `liquidator`, the keeper's public key (a Jubjub point).
- **A second note at open.** `openPosition` takes two more private arguments: a fresh random scalar `ephemeral`, and `payToEnc`, the wallet's encryption key. Without `payToEnc`, leftover equity sent to the trader would never appear in their wallet. The circuit itself inserts a `LiquidatorNote` into `liquidatorNotes`:

  ```
  k        = transientHash(ephemeral · liquidator)        ECDH on Jubjub
  note     = { ephemeral · G, plaintext[i] + transientHash(k, i) for i in 0..9 }
  plaintext = owner (a field), collateralNonce, salt (each below the field size),
              payTo, payToEnc (each as two 16-byte halves),
              size|collateral, openFee|entryPrice, openTime|isLong  (packed 64-bit pairs)
  ```

  The owner secret is not in it. Each mask is a uniformly random field element, so to anyone without `k` each ciphertext element is random, whatever it hides.
- **The nullifier is `H("zkperp:nullifier:v2", salt)`**, so the keeper can compute it.
- **`liquidatePosition(position, path, coin, pnl, closeFee, borrowFee, liquidationFee, closeTime, capacity)`** settles like a close, with three differences:
  - it takes no owner secret;
  - the position must be at a loss or flat, and its equity (collateral minus loss, closing fee and borrow fee) must be below `maintenanceBps` of size;
  - it charges a liquidation fee of `liquidationFeeBps` of size, out of the remaining equity, paid to the treasury.

  Whatever equity remains goes to `payTo`. Close and liquidation share one settlement routine.

The local stack uses 2.5% maintenance and a 0.5% fee. The keeper is `services/keeper/keeper.ts` (`npm run keeper`). It runs its own wallet, decrypts every note under the liquidator secret, logs each position with its approximate liquidation price, and liquidates those below maintenance. Portfolio shows each position's approximate liquidation price.

**Tested in `test/zkperp.test.mjs`:**

- **The note:** the keeper's key opens it into exactly the committed position plus `payToEnc`, and another key does not. A fresh scalar gives an unrelated note, and a zero scalar is refused.
- **When liquidation is refused:** a healthy position, a position in profit, and a position just above maintenance (a 7% drop at 10x) cannot be liquidated.
- **An 8% drop at 10x:** the keeper liquidates without the owner secret. The trader's `payTo` gets the equity minus the liquidation fee, the treasury gets the three fees plus the liquidation fee, the keeper's own wallet gets nothing, and the pool gains the loss.
- **After a liquidation:** the trader can no longer close the position, and it cannot be liquidated twice.
- **A race:** the trader can close an underwater position first, after which liquidation fails.
- **Wrong amounts:** an understated or overstated liquidation fee is refused, a close charges none, and the keeper cannot redirect the equity.
- **A wipe-out:** the trader gets nothing, the treasury only the opening fee, and the pool the whole collateral.
- **Privacy:** the liquidation's public data shows neither size, equity nor payout key. A long and a short open of the same size differ publicly in only the commitment and the liquidator-note ciphertext.

**Trust and limits:**

- **The keeper sees everything except the owner secret.** That is every position's size, direction, entry, collateral and payout key, and it can tell when each closes, because it knows the salt. It cannot close a healthy position, nor take any payout. This is the same kind of trust as the treasury, which sees every fee.
- **A liquidation is public as such** (the circuit name), and the pool's change shows the loss, as for any close.
- **Ephemeral scalars must be fresh.** Reusing one across two opens makes the difference between their plaintexts public.
- **`transientHash` is not promised to stay the same across compiler versions,** so the keeper decrypts each note when it appears.
- **Cost:** the `openPosition` proving key is 10.5 MB, against 9.5 MB without a liquidator note. Close and liquidation are about 37 MB. See "Proof size" below for how it got there.

### Proof size, and 1AM's limit

The first version of the liquidator note made `openPosition`'s proving key 81 MB. 1AM refused to prove it: **"Payload too large or too deeply nested"**. 1AM receives the key through the extension's messaging channel, which has a size limit.

Measured on the devnet with 1AM (2026-10-07):

| Circuit | Proving key | Through 1AM |
|---|---|---|
| pUSDC `mint` | small | ✅ ~30 s |
| `addLiquidity` | 18.6 MB | ✅ several minutes |
| `closePosition` | 37.0 MB | ✅ 49 s |
| `openPosition`, first version | 81 MB | ❌ payload too large |
| `openPosition`, current | 10.5 MB | ✅ 49 s |

So 1AM's limit lies between 37 and 81 MB. Times include approving in the wallet.

**What drives the size.** Probe contracts (`contracts/probe/costprobe.compact`, `castprobe.compact`, `castprobe2.compact`), one circuit per ingredient:

| Operation | Proving key |
|---|---|
| Variable-base `ecMul` (incl. a hash) | 0.3 MB |
| Fixed-base `ecMulGenerator` | 0.3 MB |
| 14 `transientHash` (Poseidon) | 0.1 MB |
| `Bytes<16>` argument cast to `Field` | 0.07 MB |
| `Bytes<32>` cast to `Field` (range-checked) | 0.27 MB |
| `degradeToTransient` | 0.14 MB |
| `persistentHash` of 32 bytes, compared with the hash of its two halves | 2.7 MB |
| **`slice<16>` of a `Bytes<32>`** | **4.1 MB each** |
| Five 32-byte values split by slicing | 64 MB |

The cryptography was never the problem; slicing was. The current note uses no `slice`:

- The owner is a field element.
- The salt and coin nonce are drawn below the field size (`belowField`) and cast whole.
- The wallet keys arrive as 16-byte halves, and one hash comparison ties the payout-key halves to `payTo`.

**Rule for future circuits:** keep `slice` out of anything a browser wallet must prove.

### Closing from another computer

1. Install 1AM and restore the same account from its recovery phrase.
2. Open ZKPerp and connect the wallet.
3. Enter the password. Argon2id takes about a second, then the app decrypts the notes and drops those whose nullifier is already in `closed`.
4. Close. The app proves it on the proof server on this machine (`npm run proof:up`; the wallet button shows it), 1AM adds the fees and signs, and the payout goes to this same account.

No file, backup or passkey is needed.

## Who sees the proof inputs

Every trade is a zero-knowledge proof, and the **proof server that builds it sees all its private inputs**: the position's size, direction, collateral, salt and owner secret. The chain sees none of that; the prover sees all of it. So where proving happens decides whose machine a trade's secrets pass through.

| Route | Who sends the work | To which proof server |
|---|---|---|
| CLI and scripts | our code | the one in the network config, `127.0.0.1:6300` locally |
| Browser with Lace | the app | the app's configured one, `127.0.0.1:6300` |
| Browser with 1AM | the app | the app's configured one, `127.0.0.1:6300`; 1AM only adds fees and signs |
| Browser with 1AM, local proof server down | 1AM (`getProvingProvider`) | **the one in 1AM's own network settings** (on `preview`, 1AM's hosted one) |

**1AM does not prove in the browser tab, as we had assumed.** Measured 2026-10-07 on the local network: when the browser opened and closed a position through 1AM, the local proof server logged `/check` and `/prove` requests at exactly those moments, with nothing else running. 1AM's `getConfiguration()` reports `proverServerUri: http://localhost:6300`. So the app's earlier claim that "1AM proves in this tab, so your position never leaves the browser" was wrong for this setup.

On `preview`, 1AM uses its hosted prover (`api-preview.1am.xyz`). Measured 2026-10-07: an open and a close went entirely through it, at about 40 s per proof and two proofs per trade (the contract call, then 1AM's fee balancing). The local proof server makes the same kinds of proofs in 1–13 s.

**So since 2026-10-08 the app proves the contract call itself,** on the proof server in its config, whenever that server answers its `/health` check at connect time. 1AM then only balances the fees (DUST) and signs, through `balanceUnsealedTransaction`. Its fee proofs, still made on its own prover, hold no position data. Only if the local proof server is down does 1AM prove the contract call. The app shows this:

- The wallet button shows the contract call's prover (`prover <host>`).
- The button turns red, with "not on this machine, it sees your positions", when that prover is not local. Start the proof server and reconnect to switch back.
- Status messages say where a proof is being made.

## Open items

- **Done on 2026-10-07 on the devnet:**
  - Liquidation end to end (`npm run liquidation`): the trader's wallet received the leftover equity.
  - Through 1AM in the browser: password unlock (about 1 s), open (49 s), recovery after deleting the browser's local records (the position reappeared from chain within a second), and close (49 s).
- **Done on 2026-10-08 on `preview`,** with the contract call proven locally and 1AM's prover set to LOCAL: a close in about 17 s and an open in about 11 s of proving, against about 80 s per trade through 1AM's hosted prover the day before. A liquidation after a hand-set price drop (`npm run price:preview -- 2370`): the keeper liquidated a 10x long of 198.02 on 19.80 pUSDC, with 14.98 to the pool, 1.40 to the treasury and 3.63 back to the trader.
- **Fixed on 2026-10-08:** the treasury service's public `/health` published the treasury balance and the fees received since the last epoch. Polling it before and after a trade gave away that trade's fee (0.1% of size), and so its size, which is what fee epochs exist to hide. It now shows only what the chain already shows: closes since the last epoch and the rules; `/epochs` lists each deposit's time, close count, amount and transaction. `POST /epoch`, which skipped the time rule, is gone.
- The keeper as a long-running service (`npm run keeper`) has not been run against live price moves yet; `npm run liquidation` runs the same steps in-process.
- Funding rates are not built.
- Ask the 1AM team for a deterministic signature or a way to derive a key from the wallet. If they ship one, the password could become optional.
