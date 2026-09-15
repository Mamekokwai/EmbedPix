#!/usr/bin/env bash
set -u -o pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
failures=0

grep -Eq 'embedpix\)' "$SCRIPT_DIR/stop-project-processes.sh" || { printf 'Linux process allowlist must include embedpix\n' >&2; failures=1; }
for required in '[[ -L' 'find -P' 'symlink itself'; do
    grep -Fq -- "$required" "$SCRIPT_DIR/clean-build-artifacts.sh" || { printf 'Linux cleanup is missing symlink safety check: %s\n' "$required" >&2; failures=1; }
done

for name in stop-project-processes.sh clean-build-artifacts.sh cleanup.sh check-cleanup.sh; do
    path="$SCRIPT_DIR/$name"
    if [[ ! -f "$path" ]]; then
        printf 'Missing Linux script: %s\n' "$path" >&2
        failures=1
    fi
done

for name in stop-project-processes.sh clean-build-artifacts.sh cleanup.sh; do
    path="$SCRIPT_DIR/$name"
    grep -q 'BASH_SOURCE' "$path" || { printf 'Script does not resolve its own location: %s\n' "$path" >&2; failures=1; }
    grep -Eq 'pkill|killall' "$path" && { printf 'Broad process stop found: %s\n' "$path" >&2; failures=1; }
    grep -Eq 'rm[[:space:]]+-rf[^\n]*node_modules' "$path" && { printf 'Whole node_modules removal found: %s\n' "$path" >&2; failures=1; }
done

for name in stop-project-processes.ps1 clean-build-artifacts.ps1 cleanup.ps1 check-cleanup.ps1; do
    path="$REPO_ROOT/scripts/cleanup/windows/$name"
    [[ -f "$path" ]] || { printf 'Missing paired Windows script: %s\n' "$path" >&2; failures=1; }
done

"$SCRIPT_DIR/stop-project-processes.sh" --dry-run || failures=1
"$SCRIPT_DIR/clean-build-artifacts.sh" --dry-run || failures=1
"$SCRIPT_DIR/cleanup.sh" --dry-run || failures=1

if [[ "$failures" -ne 0 ]]; then
    exit 1
fi
printf 'Linux cleanup static and dry-run checks passed.\n'
