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
if [[ "$DRY_RUN" -eq 1 ]]; then
    "$SCRIPT_DIR/stop-project-processes.sh" --dry-run || exit 1
    "$SCRIPT_DIR/clean-build-artifacts.sh" --dry-run || exit 1
else
    "$SCRIPT_DIR/stop-project-processes.sh" || exit 1
    "$SCRIPT_DIR/clean-build-artifacts.sh" || exit 1
fi
