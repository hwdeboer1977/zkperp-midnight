#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Replays a captured proving request (bench/capture-proxy.mjs) and times it.
#
#   bench/replay.sh <url> <capture.bin> [runs=5] [concurrency=1] [content-type]
#   bench/replay.sh http://localhost:6300/prove bench/captures/012_prove_80.1MB.bin 5 1
#
# Runs one warm-up first, not counted: the proof server may download the ZK
# parameters for the circuit's size on its first proof. Then `runs` rounds,
# each sending `concurrency` copies at once; with 2, it shows how proving
# degrades when two executions arrive together (a burst of stop losses).
# Prints each request's seconds, then min / median / max over all of them.
# Needs only bash, curl and awk.

set -euo pipefail
url=${1:?url, e.g. http://localhost:6300/prove}
file=${2:?a .bin from bench/captures}
runs=${3:-5}
conc=${4:-1}
ctype=${5:-application/octet-stream}

once() {
  # Prints the HTTP status and the total seconds.
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -X POST -H "content-type: $ctype" --data-binary @"$file" "$url"
}

echo "replaying $(basename "$file") ($(du -h "$file" | cut -f1)) at $url: $runs × $conc"
read -r status secs < <(once)
echo "  warm-up: $status in ${secs}s"
[ "$status" = 200 ] || { echo "  the proof server refused the payload ($status)" >&2; exit 1; }

times=()
for ((r = 1; r <= runs; r++)); do
  out=$(for ((c = 1; c <= conc; c++)); do once & done; wait)
  while read -r status secs; do
    [ "$status" = 200 ] || { echo "  run $r: HTTP $status" >&2; exit 1; }
    times+=("$secs")
  done <<<"$out"
  echo "  run $r: $(echo "$out" | awk '{printf "%ss ", $2}')"
done

printf '%s\n' "${times[@]}" | sort -n | awk '
  { v[NR] = $1 }
  END {
    m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
    printf "  min %.1fs  median %.1fs  max %.1fs  (%d requests)\n", v[1], m, v[NR], NR
  }'
