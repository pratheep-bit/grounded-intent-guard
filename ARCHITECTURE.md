# Grounded Intent Guard — Architecture

## Overview

A deterministic, non-ML pre-execution safety layer for shell commands.
Every computation uses only local filesystem state, git porcelain output,
and a simple counting-based session window.  No embeddings, no API calls,
no training data.

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Interactive Shell                            │
│   User types: rm -rf ./build   (or git reset --hard, dd of=…, …)    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  shell function intercept
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           guard.sh                                   │
│                                                                      │
│  • Wraps rm / mv / dd / chmod / chown / git via shell functions      │
│  • Non-wrapped cmds logged async via DEBUG trap (guard_log)          │
│  • Invokes guard_engine.py with the full tokenised argv              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  python3 guard_engine.py <cmd> <args>
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         guard_engine.py                              │
│                                                                      │
│  ① classify_command(argv)                                            │
│     ├─ git subcmd table  →  DESTRUCTIVE_GIT / GIT_OTHER             │
│     ├─ dd of= extraction →  OVERWRITE                                │
│     ├─ CATEGORY_RULES    →  DELETE / OVERWRITE / PERMISSION / MOVE  │
│     └─ fallthrough       →  OTHER                                    │
│                                                                      │
│  ② compute_impact_vector(paths, cwd, category)                       │
│     ├─ Walk real filesystem: file_count, total_bytes                 │
│     ├─ device_size_bytes()  for raw block devices (dd / of=)        │
│     ├─ check_git_state()    (only for GIT categories)               │
│     │    ├─ git status --porcelain  → dirty_files, git_uncommitted  │
│     │    └─ git log @{u}..          → git_unpushed                  │
│     ├─ sum_file_sizes()     grounds DESTRUCTIVE_GIT when paths=[]   │
│     ├─ crosses_mount_boundary check (st_dev comparison)             │
│     └─ check_open_handles() via lsof (best-effort)                  │
│                                                                      │
│  ③ record_and_score_drift(category)                                  │
│     └─ Load/update rolling WINDOW_SIZE session window in            │
│        GUARD_SESSION_FILE; coherence = matches/window_len           │
│        drift = 1 − coherence  (0.0 when history < 4 entries)        │
│                                                                      │
│  ④ compute_recoverability(impact)                                    │
│     └─ Additive score: git clean? trash-put available? snapshot?    │
│                                                                      │
│  ⑤ compute_risk_score(impact, drift, recoverability)                 │
│     └─ Weighted sum:                                                 │
│           impact_signal × 0.45                                       │
│         + drift          × 0.25                                      │
│         + irreversibility× 0.30   (= 1 − recoverability)            │
│        Block-device shortcut → 0.95 regardless of other signals     │
│                                                                      │
│  ⑥ decide_action(score)                                              │
│     ├─ score < 0.30  →  ALLOW   (silent pass-through)               │
│     ├─ score < 0.55  →  WARN    (print explanation, proceed)        │
│     ├─ score < 0.80  →  CONFIRM (interactive y/N prompt)            │
│     └─ score ≥ 0.80  →  BLOCK   (exit 1, command never runs)        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  exit 0  →  command runs
                                │  exit 1  →  command is suppressed
                                ▼
                    ┌───────────────────────┐
                    │  Original command     │
                    │  (via `command rm …`) │
                    │  — or — suppressed    │
                    └───────────────────────┘
```

---

## Component Responsibilities

| Component | File | Role |
|---|---|---|
| Shell wrapper | `guard.sh` | Intercept, log async context, invoke engine |
| Risk engine | `guard_engine.py` | Classify, measure, score, decide |
| Session state | `$GUARD_SESSION_FILE` | Rolling window of command categories (JSON) |

---

## Key Design Decisions

1. **No ML** — classification is a deterministic lookup table; drift is a
   simple frequency count.  The engine can run offline, in a container, or
   on a cold CI runner without any model files.

2. **Impact is grounded** — the score reflects what the command would *actually*
   touch on this machine right now (real file sizes, real git porcelain output),
   not just the command string.  `rm nonexistent` scores near-zero; `rm -rf /`
   scores near-one.

3. **Git state only for git commands** — checking git status unconditionally
   for every command (rm, dd, chmod…) would produce false positives: "sitting
   inside a dirty repo" ≠ "the command touches uncommitted work."

4. **Drift as context signal** — a sudden `git reset --hard` after a long
   session of `ls` / `cat` / `grep` is more suspicious than one inside a
   workflow that has been doing git operations all along.  Drift penalises
   sharp category switches without blocking them outright.

5. **Transparent thresholds** — `RISK_THRESHOLDS` and `RISK_WEIGHTS` are
   plain module-level constants, not buried in a model.  A team can read,
   debate, and adjust them in one place.
