# guard_engine.py
"""guard_engine.py -- core risk computation for the Grounded Intent Guard.

Invoked two ways by guard.sh:
  1. guard_engine.py <cmd> <args...>          -- full check, may prompt, exit
     code 0 = proceed, 1 = abort.
  2. guard_engine.py --log-only "<raw cmd>"   -- cheap, non-blocking: just
     records this command's category for trajectory-drift context.
"""
import glob
import json
import os
import stat as stat_module
import subprocess
import sys
import shlex
from pathlib import Path

SESSION_FILE = Path(os.environ.get("GUARD_SESSION_FILE", "/tmp/guard_session.json"))
# PLACEHOLDER: session file location. /tmp is fine on a single-user demo
# machine but is world-writable on shared systems -- move this under
# $XDG_RUNTIME_DIR or similar for anything beyond a hackathon demo.

WINDOW_SIZE = 12
# PLACEHOLDER: how many recent commands feed the drift calculation. Tune by
# eye during rehearsal -- too small and drift is noisy/meaningless, too
# large and it reacts too slowly to a real context switch.

CATEGORY_RULES = [
    ("DELETE", {"rm", "shred", "unlink"}),
    ("OVERWRITE", {"dd", "truncate"}),
    ("PERMISSION", {"chmod", "chown", "chgrp"}),
    ("MOVE", {"mv"}),
]
# Intentionally scoped to commands whose danger is well represented by a
# file-centric impact vector (bytes/files/git-state/handles). `kill`,
# package managers, docker/kubectl etc. are real risks too, but they need a
# different impact model (process state, dependency graphs) that this MVP
# does not build. Add them as a follow-on rather than reusing this scoring
# as-is.
# PLACEHOLDER: extend this set for whatever your demo actually needs to
# intercept.

RISK_THRESHOLDS = {"WARN": 0.3, "CONFIRM": 0.55, "BLOCK": 0.8}
# PLACEHOLDER: risk-score cut points (0-1 scale) mapping to action tiers.
# These are guesses. Calibrate against the actual demo scenarios you'll
# show judges so "medium" and "high" visibly differ on stage.

RISK_WEIGHTS = {"impact": 0.45, "drift": 0.25, "irreversibility": 0.30}
# PLACEHOLDER: relative weight of each signal in the final risk score.
# Chosen so real data-loss impact dominates; re-tune after testing against
# your own demo scenarios.


def extract_paths(args):
    """Best-effort target extraction: skip flags, expand globs, keep
    whatever's left as a candidate path. Deliberately naive -- it doesn't
    know per-command argument arities (e.g. chmod's MODE isn't a path), but
    non-existent candidates are filtered out later in compute_impact_vector,
    which makes false positives here mostly harmless."""
    paths = []
    for a in args:
        if a.startswith("-"):
            continue
        expanded = glob.glob(a)
        paths.extend(expanded if expanded else [a])
    return paths


def extract_dd_paths(args):
    """dd uses key=value args; only `of=` (output target) matters for risk."""
    paths = []
    for a in args:
        if a.startswith("of="):
            paths.append(a[3:])
    return paths


def classify_command(argv):
    """argv is already tokenized by bash itself (via "$@") -- no separate
    shell parser needed."""
    if not argv:
        return "OTHER", []
    cmd = argv[0]
    if cmd == "git":
        rest = argv[1:]
        if rest[:1] == ["reset"] and "--hard" in rest:
            return "DESTRUCTIVE_GIT", extract_paths(rest[1:])
        if rest[:1] == ["clean"]:
            return "DESTRUCTIVE_GIT", extract_paths(rest[1:])
        if rest[:1] == ["push"] and ("--force" in rest or "-f" in rest):
            return "DESTRUCTIVE_GIT", extract_paths(rest[1:])
        return "GIT_OTHER", extract_paths(rest[1:])
    if cmd == "dd":
        return "OVERWRITE", extract_dd_paths(argv[1:])
    for cat, names in CATEGORY_RULES:
        if cmd in names:
            return cat, extract_paths(argv[1:])
    return "OTHER", extract_paths(argv[1:])


def device_size_bytes(path):
    """Real capacity of a block device (e.g. /dev/sda), not the ~0 that
    plain stat() reports for special files. This is what lets the engine
    recognize `dd of=/dev/sdX` as catastrophic rather than a 0-byte no-op."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not stat_module.S_ISBLK(st.st_mode):
        return None
    try:
        result = subprocess.run(["blockdev", "--getsize64", path],
                                 capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            return int(result.stdout.strip())
    except (subprocess.SubprocessError, OSError, ValueError):
        pass
    return None


def check_git_state(cwd, existing_paths):
    """Returns (has_uncommitted_changes, has_unpushed_commits, dirty_files).
    dirty_files is used to ground `git reset --hard` / `git clean` impact
    even when the command itself names no explicit path."""
    try:
        inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                                 cwd=cwd, capture_output=True, text=True, timeout=2)
        if inside.returncode != 0:
            return False, False, []
    except (subprocess.SubprocessError, OSError):
        return False, False, []

    dirty_files = []
    try:
        status = subprocess.run(["git", "status", "--porcelain"],
                                 cwd=cwd, capture_output=True, text=True, timeout=2)
        for line in status.stdout.splitlines():
            if len(line) > 3:
                # Note: rename lines ("R  old -> new") aren't split out
                # specially; the raw remainder is kept as one string. Known
                # simplification, fine for the MVP's demo scenarios.
                dirty_files.append(line[3:])
        uncommitted = bool(dirty_files)
    except (subprocess.SubprocessError, OSError):
        uncommitted = False
    try:
        unpushed = subprocess.run(["git", "log", "@{u}..", "--oneline"],
                                   cwd=cwd, capture_output=True, text=True, timeout=2)
        has_unpushed = bool(unpushed.stdout.strip())
    except (subprocess.SubprocessError, OSError):
        has_unpushed = False
    return uncommitted, has_unpushed, dirty_files


def sum_file_sizes(cwd, rel_paths):
    total = 0
    for rp in rel_paths:
        fp = Path(cwd) / rp
        try:
            total += fp.stat().st_size
        except OSError:
            pass
    return total


def check_open_handles(existing_paths):
    """Best-effort: which process names currently hold a handle under a
    target path. Silently returns [] if lsof isn't installed."""
    if not existing_paths:
        return []
    try:
        result = subprocess.run(
            ["lsof", "+D"] + [str(p) for p in existing_paths[:5]],
            # PLACEHOLDER: capped to the first 5 paths to keep lsof fast in
            # a live demo -- widen if your scenario needs more coverage.
            capture_output=True, text=True, timeout=2,
        )
        procs = set()
        for line in result.stdout.splitlines()[1:]:
            parts = line.split()
            if parts:
                procs.add(parts[0])
        return sorted(procs)
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        return []


def compute_impact_vector(paths, cwd, category=None):
    """The core differentiator: ground risk in what the command would
    actually touch right now, not in the command string alone."""
    file_count = 0
    total_bytes = 0
    existing = []
    is_block_device = False

    for p in paths:
        pp = Path(p)
        if not pp.exists():
            continue
        existing.append(pp)
        dev_size = device_size_bytes(str(pp))
        if dev_size is not None:
            is_block_device = True
            total_bytes += dev_size
            file_count += 1
            continue
        if pp.is_dir():
            for root, _, files in os.walk(pp):
                for f in files:
                    fp = Path(root) / f
                    try:
                        total_bytes += fp.stat().st_size
                        file_count += 1
                    except OSError:
                        pass
                # PLACEHOLDER: no cap on walk size. For a very large tree
                # this is slow; add an early-exit sample/estimate (walk a
                # few thousand entries, then extrapolate) if your demo
                # directory is huge, rather than walking everything.
        else:
            try:
                total_bytes += pp.stat().st_size
                file_count += 1
            except OSError:
                pass

    crosses_mount = False
    try:
        cwd_dev = os.stat(cwd).st_dev
        for pp in existing:
            try:
                if pp.stat().st_dev != cwd_dev:
                    crosses_mount = True
                    break
            except OSError:
                pass
    except OSError:
        pass

    # Only consult git state for git-category commands. Checking cwd's git
    # status unconditionally for every command (rm, dd, chmod...) produces
    # false positives: deleting something unrelated while merely sitting
    # inside a dirty repo elsewhere would otherwise be misreported as
    # "includes uncommitted git changes." Verified bug, fixed here.
    if category in ("DESTRUCTIVE_GIT", "GIT_OTHER"):
        git_uncommitted, git_unpushed, dirty_files = check_git_state(cwd, existing)
    else:
        git_uncommitted, git_unpushed, dirty_files = False, False, []

    if category == "DESTRUCTIVE_GIT" and not existing and dirty_files:
        # git reset/clean act on the working tree, not on explicit path
        # arguments -- ground the impact in the real dirty-file list
        # instead of reporting zero affected files.
        file_count = len(dirty_files)
        total_bytes = sum_file_sizes(cwd, dirty_files)

    held_by_process = check_open_handles(existing)

    return {
        "file_count": file_count,
        "total_bytes": total_bytes,
        "crosses_mount_boundary": crosses_mount,
        "git_uncommitted": git_uncommitted,
        "git_unpushed": git_unpushed,
        "held_by_process": held_by_process,
        "targets_existed": len(existing),
        "is_block_device": is_block_device,
    }


def trash_available():
    return subprocess.call(["which", "trash-put"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL) == 0
    # PLACEHOLDER: checks specifically for trash-cli. Swap in whatever
    # recycle-bin/undo mechanism your demo machine actually has (gio trash,
    # a project backup script, etc.) if trash-cli isn't installed.


def snapshot_available():
    # PLACEHOLDER: not implemented. Wire this to `btrfs subvolume list` /
    # `zfs list -t snapshot` / your own backup tool if your demo filesystem
    # actually supports snapshots. Until then this always contributes 0 and
    # recoverability leans on git + trash only.
    return False


def compute_recoverability(impact):
    """0.0 = irreversible, 1.0 = trivially recoverable."""
    score = 0.0
    if not impact["git_uncommitted"]:
        score += 0.3
    if not impact["git_unpushed"]:
        score += 0.2
    if trash_available():
        score += 0.3
    if snapshot_available():
        score += 0.2
    return min(score, 1.0)


def load_session():
    if SESSION_FILE.exists():
        try:
            return json.loads(SESSION_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"window": []}


def save_session(state):
    try:
        SESSION_FILE.write_text(json.dumps(state))
    except OSError:
        pass


def record_and_score_drift(category):
    """Deterministic, purely-counting drift signal: no training, no model
    persisted across sessions, no embeddings. Compares the current
    command's category against the empirical distribution of the last
    WINDOW_SIZE commands in *this* session only."""
    state = load_session()
    window = state.get("window", [])
    if len(window) < 4:
        drift = 0.0  # not enough history to say anything meaningful yet
    else:
        matches = sum(1 for c in window if c == category)
        coherence = matches / len(window)
        drift = 1.0 - coherence
    window.append(category)
    state["window"] = window[-WINDOW_SIZE:]
    save_session(state)
    return drift


def compute_risk_score(impact, drift, recoverability):
    if impact.get("is_block_device"):
        return 0.95
    irreversibility = 1.0 - recoverability
    impact_signal = 0.0
    if impact["file_count"] > 0:
        # Base signal just for touching *any* real, existing target --
        # a 1-file, high-irreversibility case (e.g. one uncommitted file
        # about to be wiped) must not score near-zero just because file
        # count and byte size are both small. Volume scales the signal
        # up further, it doesn't gate whether there's a signal at all.
        impact_signal += 0.15
        impact_signal += min(impact["file_count"] / 500.0, 1.0) * 0.35
        impact_signal += min(impact["total_bytes"] / (500 * 1024 * 1024), 1.0) * 0.2
        # PLACEHOLDER: 500-file / 500MB normalization points are guesses --
        # set to whatever "a lot" means for your demo dataset.
    if impact["crosses_mount_boundary"]:
        impact_signal += 0.1
    if impact["held_by_process"]:
        impact_signal += 0.1
    impact_signal = min(impact_signal, 1.0)

    score = (RISK_WEIGHTS["impact"] * impact_signal
             + RISK_WEIGHTS["drift"] * drift
             + RISK_WEIGHTS["irreversibility"] * irreversibility)
    return min(score, 1.0)


def decide_action(score):
    if score >= RISK_THRESHOLDS["BLOCK"]:
        return "BLOCK"
    if score >= RISK_THRESHOLDS["CONFIRM"]:
        return "CONFIRM"
    if score >= RISK_THRESHOLDS["WARN"]:
        return "WARN"
    return "ALLOW"


def generate_explanation(category, impact, drift, recoverability, score):
    lines = []
    if impact["file_count"]:
        mb = impact["total_bytes"] / (1024 * 1024)
        if impact.get("is_block_device"):
            lines.append(f"Target is a raw block device (~{mb:.0f} MB) -- this "
                          f"overwrites an entire disk/partition, not a regular file.")
        else:
            lines.append(f"Affects {impact['file_count']} file(s), {mb:.1f} MB.")
    if impact["git_uncommitted"]:
        lines.append("Includes uncommitted git changes.")
    if impact["git_unpushed"]:
        lines.append("Includes commits not yet pushed to a remote.")
    if impact["crosses_mount_boundary"]:
        lines.append("Target crosses a filesystem/mount boundary from the current directory.")
    if impact["held_by_process"]:
        lines.append(f"Currently open by: {', '.join(impact['held_by_process'])}.")
    if drift > 0.6:
        lines.append(f"Sharp departure from your last {WINDOW_SIZE} commands (category: {category}).")
    lines.append(f"Recoverability score: {recoverability:.2f}/1.0 (higher = easier to undo).")
    lines.append(f"Overall risk score: {score:.2f}/1.0.")
    return "\n".join(lines) if lines else "No specific impact detected."


SUGGESTIONS = {
    "DELETE": "Consider `trash-put` instead of `rm`, or add `-i` for per-file confirmation.",
    "OVERWRITE": "Test with a small block count first, and double-check `of=` before running.",
    "PERMISSION": "Preview with `chmod --changes -R` first; scope to a subdirectory before recursing widely.",
    "MOVE": "Add `-i` (or `-n`) so an existing destination file isn't silently clobbered.",
    "DESTRUCTIVE_GIT": "Run `git stash` (or push your branch) before resetting/cleaning.",
}


def suggest_alternative(category):
    return SUGGESTIONS.get(category, "Re-check the target and consider a --dry-run or a narrower scope first.")


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(0)

    log_only = False
    if argv[0] == "--log-only":
        log_only = True
        argv = shlex.split(argv[1]) if len(argv) > 1 else []
        if not argv:
            sys.exit(0)

    cwd = os.getcwd()
    category, paths = classify_command(argv)

    if log_only:
        record_and_score_drift(category)
        sys.exit(0)

    impact = compute_impact_vector(paths, cwd, category)
    recoverability = compute_recoverability(impact)
    drift = record_and_score_drift(category)
    score = compute_risk_score(impact, drift, recoverability)
    action = decide_action(score)

    if action == "ALLOW":
        sys.exit(0)

    explanation = generate_explanation(category, impact, drift, recoverability, score)
    suggestion = suggest_alternative(category)
    print(f"\n[guard] {category} risk={score:.2f} action={action}", file=sys.stderr)
    print(explanation, file=sys.stderr)
    print(f"Suggested alternative: {suggestion}", file=sys.stderr)

    if action == "WARN":
        sys.exit(0)
    if action == "BLOCK":
        print("[guard] Blocked.", file=sys.stderr)
        sys.exit(1)

    try:
        reply = input(f"[guard] Proceed with this {category} anyway? [y/N] ")
    except EOFError:
        reply = "n"
    sys.exit(0 if reply.strip().lower() == "y" else 1)


if __name__ == "__main__":
    main()