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

remove_target() {
    local label="$1"
    local relative_path="$2"
    local target="$REPO_ROOT/$relative_path"

    case "$target" in
        "$REPO_ROOT"/*) ;;
        *) printf 'Refusing to clean path outside project root: %s\n' "$target" >&2; return 1 ;;
    esac

    assert_parent_chain_safe "$target" || return 1

    if [[ ! -e "$target" && ! -L "$target" ]]; then
        printf 'Skip: %s is absent (%s)\n' "$label" "$target"
        return 0
    fi

    if [[ -L "$target" ]]; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
            printf '[dry-run] would remove symlink itself, not its target: %s (%s)\n' "$label" "$target"
            return 0
        fi
        if rm -f -- "$target"; then
            printf 'Removed symlink itself: %s (%s)\n' "$label" "$target"
        else
            printf 'Failed to remove symlink: %s (%s)\n' "$label" "$target" >&2
            return 1
        fi
        return 0
    fi

    if [[ -d "$target" ]] && find -P "$target" -type l -print -quit | grep -q .; then
        printf 'Refusing to recurse through a nested symlink under %s; remove the link first.\n' "$target" >&2
        return 1
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '[dry-run] would remove %s (%s)\n' "$label" "$target"
        return 0
    fi

    if rm -rf -- "$target"; then
        printf 'Removed: %s (%s)\n' "$label" "$target"
    else
        printf 'Failed to remove %s (%s)\n' "$label" "$target" >&2
        return 1
    fi
}

assert_parent_chain_safe() {
    local target="$1"
    local current
    current="$(dirname -- "$target")"
    while [[ "$current" != "$REPO_ROOT" ]]; do
        if [[ -L "$current" ]]; then
            printf 'Refusing to clean symlink parent: %s\n' "$current" >&2
            return 1
        fi
        case "$current" in
            "$REPO_ROOT"/*) ;;
            *) printf 'Refusing to clean path without project-root parent: %s\n' "$target" >&2; return 1 ;;
        esac
        current="$(dirname -- "$current")"
    done
}

remove_target 'frontend dist' 'dist' || exit 1
remove_target 'Vite cache' 'node_modules/.vite' || exit 1
remove_target 'Tauri target' 'src-tauri/target' || exit 1
exit 0
