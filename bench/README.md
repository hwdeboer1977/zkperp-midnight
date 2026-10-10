# Benchmarking the proof server

How fast a machine proves zkperp's transactions, measured without a chain: the proof server keeps no state between requests, and midnight-js sends each circuit's proving key along with the request. So a request captured once replays anywhere with only the proof server and curl.

| File | What it does |
|---|---|
| `capture-proxy.mjs` | A proxy in front of a proof server; saves each `/prove` and `/check` body to `captures/` |
| `replay.sh` | Replays one capture, times it, prints min / median / max; one warm-up first, not counted |
| `scale.sh` | Replays one capture on a fresh proof server pinned to 1, 2, 4… vCPUs, with peak memory |

`captures/` is git-ignored: a capture holds the private inputs of the transaction it came from. Capture on the devnet only, never from `preview` or production.

## 1. Capture (on the devnet)

```bash
node bench/capture-proxy.mjs                                   # :6301 → :6300
PROOF_SERVER_URL=http://127.0.0.1:6301 npm run stoploss        # in another terminal
```

Every proof the script makes is saved; the size of the key in the body tells the circuit:

| Body | Circuit |
|---|---|
| 76.7 MB | `executeOrder` (the keeper) |
| 38.8 MB | `closePosition` |
| 11.1 MB | `openPosition` |
| 10.0 MB | `placeOrder` |
| 5.2 MB | `cancelOrder` |
| 2.8 MB | `setPrice` (the relayer) |
| a few KB | the transaction's coin and fee proofs, whose keys the proof server has built in |

`npm run liquidation` through the proxy captures `liquidatePosition` the same way.

## 2. Replay

```bash
bench/replay.sh http://127.0.0.1:6300/prove bench/captures/<n>_prove_76.7MB.bin 5 1   # 5 runs, one at a time
bench/replay.sh http://127.0.0.1:6300/prove bench/captures/<n>_prove_76.7MB.bin 3 2   # 3 rounds of 2 at once
bench/scale.sh bench/captures/<n>_prove_76.7MB.bin 1 2 4 8 16                        # the scaling curve
```

A 200 from a freshly started proof server shows the capture is self-contained (checked 2026-10-09). Its first proof also loads the ZK parameters: 40–110 s, which `replay.sh` leaves out.

## 3. On a rented machine

Clouds bill by the hour or second; an hour per machine is plenty.

```bash
# on the machine: Docker, then
docker pull midnightntwrk/proof-server:8.1.0     # the version the stack runs (package.json, proof:up)
scp bench/replay.sh bench/scale.sh bench/captures/<n>_prove_76.7MB.bin  box:
./scale.sh <n>_prove_76.7MB.bin 2 4 8 16          # up to the machine's vCPUs
./replay.sh http://127.0.0.1:6400/prove <n>_prove_76.7MB.bin 3 2   # with a server on :6400, for the burst case
```

Candidates: Hetzner Cloud CCX (dedicated vCPUs), AWS c7a (cheaper as spot), GCP c3d. Bare metal usually needs a monthly commitment: benchmark the nearest hourly machine first.

For a fair comparison: the same capture, the same proof server version, warm runs only. Check `docker image inspect --format '{{.Architecture}}'`: an amd64 image emulated on an ARM machine gives meaningless numbers. Laptops throttle under sustained load.

## Results

### 2026-10-09, AMD Ryzen 9 3900X (12 cores, 24 threads, 2019), WSL2 with 15.6 GiB

`executeOrder`, 76.7 MB, warm, one at a time:

| vCPUs | Proof | Speed-up from the row above | Peak memory |
|---|---|---|---|
| 1 | 67.7 s | | 3.4 GiB |
| 2 | 39.7 s | 1.7× | 3.5 GiB |
| 4 | 23.5 s | 1.7× | 3.6 GiB |
| 8 | 16.2 s | 1.45× | 3.7 GiB |
| 16 | 13.9 s | 1.17× | 3.8 GiB |
| 24 | 12.8 s | 1.09× | 3.7 GiB |

Two at once:

| vCPUs | Each | Per proof, over the pair |
|---|---|---|
| 8 | 26.2 s | 13.1 s |
| 24 | 17.1 s | 8.6 s |

What it says:

- **One proof flattens at about 8 vCPUs.** The times fit about 10 s of serial work plus 57 s that spreads over cores. Past 8 vCPUs, a faster core (newer generation, higher clock) shortens the 10 s; more cores barely do.
- **More cores pay off for bursts.** Two proofs at once share the cores the single proof could not use: 24 vCPUs clear a pair at 8.6 s per proof. The keeper executes one order at a time today, so it would need to prove several at once to benefit.
- **Memory:** about 3.5–4 GiB per proof in flight. A keeper that proves two at once needs 8 GiB for proving alone; 16 GiB leaves room.
- The vCPU counts are WSL2's logical CPUs, mapped by Hyper-V; how they sit on physical cores is not guaranteed, so the 1 and 2 vCPU rows are the least comparable to a cloud machine.
- In the live run the same proof took 21–31 s: there it shared the CPU with the transaction's other proofs, which the proof server runs in parallel just before it.
