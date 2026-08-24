#!/usr/bin/env bash
# Source this from an interactive shell: source /path/to/guard.sh

GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PLACEHOLDER: assumes guard_engine.py lives next to this script. Adjust if
# you install the pieces in different directories.

GUARD_PYTHON="python3"
# PLACEHOLDER: point this at whichever python3 has the interpreter you
# tested against (e.g. a venv path) if the `python3` on PATH isn't it.

GUARD_WRAPPED_CMDS="rm mv dd chmod chown git"
# PLACEHOLDER: must match the function names defined below. Add a wrapper
# function AND add the name here if you extend coverage.

guard_check() {
    "$GUARD_PYTHON" "$GUARD_DIR/guard_engine.py" "$@"
}

# --- lightweight, non-blocking session logging for trajectory context ---
guard_log() {
    local cmd_line="$1"
    local first_word="${cmd_line%% *}"
    case " $GUARD_WRAPPED_CMDS " in
        *" $first_word "*) return 0 ;;  # already logged by the blocking wrapper below
    esac
    # Fire-and-forget; never blocks or affects the command about to run.
    # PLACEHOLDER: spawns a python process per typed command purely to log
    # its category. Fine for a demo; replace with a cheap bash `case`
    # statement categorizer if this is noticeably laggy on stage.
    ( "$GUARD_PYTHON" "$GUARD_DIR/guard_engine.py" --log-only "$cmd_line" >/dev/null 2>&1 & )
}
trap 'guard_log "$BASH_COMMAND"' DEBUG
# CAVEAT: DEBUG fires before every simple command in shells that source this
# rc file, including inside sourced scripts. Verify it doesn't fire
# somewhere noisy/slow in your actual demo shell before relying on it live.

# --- blocking wrappers for the specific commands we actually guard ---
rm()    { guard_check rm    "$@" && command rm    "$@"; }
mv()    { guard_check mv    "$@" && command mv    "$@"; }
dd()    { guard_check dd    "$@" && command dd    "$@"; }
chmod() { guard_check chmod "$@" && command chmod "$@"; }
chown() { guard_check chown "$@" && command chown "$@"; }
git()   { guard_check git   "$@" && command git   "$@"; }
# KNOWN, DISCLOSED LIMITATION: function-wrapping is bypassed by an escaped
# name (`\rm`), a full path (`/bin/rm`), or a non-interactive script that
# never sources this file. Don't trigger it by accident on stage; if you
# want to show it, show it as a named, understood limitation, not a
# surprise.
