#!/usr/bin/env bash
set -u -o pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run|-n) DRY_RUN=1 ;;
        *) printf 'Usage: %s [--dry-run|-n]\n' "$0" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
printf 'Project root: %s\n' "$REPO_ROOT"

pids=()
names=()
while read -r pid _ppid comm args; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$comm" in
        node|npm|npx|pnpm|yarn|bun|cargo|rustc|tauri|vite) ;;
        *) continue ;;
    esac
    [[ "$pid" -ne "$$" ]] || continue
    [[ "$args" == *"$REPO_ROOT"* ]] || continue
    pids+=("$pid")
    names+=("$comm")
done < <(ps -eo pid=,ppid=,comm=,args=)

if [[ "${#pids[@]}" -eq 0 ]]; then
    printf 'No project-scoped dev/build processes found.\n'
    exit 0
fi

failures=0
for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    name="${names[$index]}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '[dry-run] would stop %s (PID %s)\n' "$name" "$pid"
        continue
    fi

    if kill -TERM "$pid" 2>/dev/null; then
        printf 'Stopped: %s (PID %s)\n' "$name" "$pid"
    else
        printf 'Failed to stop: %s (PID %s)\n' "$name" "$pid" >&2
        failures=1
    fi
done

if [[ "$DRY_RUN" -eq 0 ]]; then
    for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || failures=1
        fi
    done
fi

exit "$failures"
