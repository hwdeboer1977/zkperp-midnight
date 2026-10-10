#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# How proving time scales with CPUs: one captured request, replayed on a
# fresh proof server pinned to 1, 2, 4… vCPUs (logical CPUs, as clouds sell
# them), with the peak memory of each.
#
#   bench/scale.sh <capture.bin> [vCPU counts…]
#   bench/scale.sh bench/captures/077_prove_76.7MB.bin 1 2 4 8 16 24
#
# Environment: IMAGE (midnightntwrk/proof-server:8.1.0), PORT (6400),
# RUNS (warm runs per setting; default 3, 1 at 2 vCPUs or fewer).
# Needs Docker, curl, awk and bench/replay.sh beside it.

set -euo pipefail
file=${1:?a .bin from bench/captures}
shift
counts=("${@:-1 2 4 8 16 24}")
[ $# -eq 0 ] && read -r -a counts <<<"1 2 4 8 16 24"
image=${IMAGE:-midnightntwrk/proof-server:8.1.0}
port=${PORT:-6400}
here=$(dirname "$0")
name=ps-scale
total=$(nproc)

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Peak of `docker stats` memory usage, in MiB, while the container lives.
sample_memory() {
  local peak=0 v
  while docker inspect "$name" >/dev/null 2>&1; do
    v=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" 2>/dev/null | awk '{
      n = $1 + 0; u = $1; gsub(/[0-9.]/, "", u)
      if (u == "GiB") n *= 1024; else if (u == "KiB") n /= 1024; else if (u == "B") n /= 1048576
      printf "%d", n }')
    [ -n "$v" ] && [ "$v" -gt "$peak" ] && peak=$v && echo "$peak" >"$1"
    sleep 1
  done
}

echo "$(basename "$file") on $image, this machine: $total logical CPUs, $(lscpu 2>/dev/null | awk -F: '/Model name/ {gsub(/^ +/, "", $2); print $2}')"
summary=()
for c in "${counts[@]}"; do
  [ "$c" -le "$total" ] || { echo "skipping $c vCPUs: only $total here"; continue; }
  cleanup
  docker run -d --name "$name" --cpuset-cpus="0-$((c - 1))" -p "$port:6300" "$image" midnight-proof-server -v >/dev/null
  until curl -sf "http://127.0.0.1:$port/health" >/dev/null; do sleep 1; done
  peakfile=$(mktemp)
  echo 0 >"$peakfile"
  sample_memory "$peakfile" &
  sampler=$!
  runs=${RUNS:-$([ "$c" -le 2 ] && echo 1 || echo 3)}
  echo
  echo "── $c vCPU(s)"
  out=$("$here/replay.sh" "http://127.0.0.1:$port/prove" "$file" "$runs" 1 | tee /dev/stderr)
  cleanup
  wait "$sampler" 2>/dev/null || true
  median=$(echo "$out" | awk '/median/ { for (i = 1; i <= NF; i++) if ($i == "median") print $(i + 1) }')
  summary+=("$c vCPU: median $median, peak memory $(cat "$peakfile") MiB")
  rm -f "$peakfile"
done

echo
echo "summary ($(basename "$file"))"
printf '  %s\n' "${summary[@]}"
