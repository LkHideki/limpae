#!/usr/bin/env bash
# Measures Limpae on this Mac. Read-only: nothing is removed.
#   scripts/measure.sh engine   time and peak memory of each scanner on the real home folder (one process each)
#   scripts/measure.sh app      CPU and memory of the built app: focused, in the background, focused again
#   scripts/measure.sh          both
# `app` opens the release bundle (build it first with `cargo tauri build --bundles app`) for about 40 seconds.
set -euo pipefail
cd "$(dirname "$0")/.."

engine() {
    cargo build -q -p limpa-core --release --example bench
    echo "== engine (real home, read-only)"
    for s in junk large dups lens; do target/release/examples/bench "$s"; done
}

webkit_pids() { pgrep -f 'com.apple.WebKit.(WebContent|GPU|Networking)' | sort -n || true; }

# Samples the summed %CPU and RSS of the pids in $1 (comma-separated) once a second for $2 seconds; prints avg/max.
sample() {
    local pids=$1 secs=$2 label=$3 cpu rss
    local -a cpus=() rsss=()
    for _ in $(seq 1 "$secs"); do
        read -r cpu rss < <(ps -o %cpu=,rss= -p "$pids" | awk '{c+=$1; r+=$2} END {print c, r}') || return 1
        cpus+=("$cpu"); rsss+=("$rss")
        sleep 1
    done
    printf '%s\n' "${cpus[@]}" | awk -v l="$label" -v r="$(printf '%s\n' "${rsss[@]}" | sort -n | tail -1)" \
        '{s+=$1; if($1>m)m=$1} END {printf "%-22s cpu avg %5.1f%%  max %5.1f%%  rss max %4.0f MB\n", l, s/NR, m, r/1024}'
}

app() {
    local bundle="target/release/bundle/macos/Limpae.app"
    [ -d "$bundle" ] || { echo "Build the bundle first: cargo tauri build --bundles app" >&2; exit 1; }
    local abs; abs="$(cd "$bundle" && pwd)"
    echo "== app ($abs)"
    local before; before="$(webkit_pids)"
    open -n "$abs"
    local pid=""
    for _ in $(seq 1 20); do pid="$(pgrep -f "$abs/Contents/MacOS/" | head -1 || true)"; [ -n "$pid" ] && break; sleep 0.5; done
    [ -n "$pid" ] || { echo "the app did not start" >&2; exit 1; }
    sleep 3 # first paint
    # The page renders in WebKit's own processes; the ones that appeared with the app are counted with it.
    local web; web="$(comm -13 <(echo "$before") <(webkit_pids) | paste -sd, -)"
    local all="$pid${web:+,$web}"
    echo "app pid $pid, WebKit pids ${web:-none}"
    sample "$pid" 10 "focused, idle (app)"
    sample "$all" 10 "focused, idle (+WebKit)"
    open -a Finder; sleep 1
    sample "$all" 10 "background (+WebKit)"
    open "$abs"; sleep 1
    sample "$all" 10 "focused again (+WebKit)"
    kill "$pid"
}

case "${1:-all}" in
    engine) engine ;;
    app) app ;;
    all) engine; app ;;
    *) echo "usage: $0 [engine|app]" >&2; exit 2 ;;
esac
