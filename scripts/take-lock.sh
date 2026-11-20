#!/usr/bin/env bash
# Takes a lock directory (e.g. C:/repo/locks/tsc) with its `owner` file already inside, in one atomic step:
# the directory is built under a temporary name, then renamed to the lock name. A rename onto an existing, non-empty
# lock fails, so there is never a lock directory without an owner. Usage: take-lock.sh <lock-dir> [owner-text]
# Exit 0 = taken, 1 = held by someone else.
lock="$1"; owner="${2:-pid $$ $(date +%s) ${CLAUDE_CODE_SESSION_ID:-}}"
tmp="${lock}.tmp.$$"
mkdir "$tmp" || exit 2
printf '%s\n' "$owner" > "$tmp/owner"
if [ -e "$lock" ]; then rm -rf "$tmp"; exit 1; fi
if mv -T "$tmp" "$lock" 2>/dev/null || mv "$tmp" "$lock" 2>/dev/null; then
  [ -f "$lock/owner" ] && exit 0
fi
rm -rf "$tmp"; exit 1
