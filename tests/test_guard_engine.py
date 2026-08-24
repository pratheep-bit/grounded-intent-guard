"""
tests/test_guard_engine.py
Pytest suite for guard_engine.py  — fully deterministic, no ML, no network.
Run with:  pytest -v tests/
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Make the project root importable even when pytest is invoked from the repo
# root or from the tests/ directory.
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).parent.parent))

import guard_engine as ge  # noqa: E402  (import after sys.path fixup)


# ===========================================================================
# 1.  classify_command()
# ===========================================================================


class TestClassifyCommand:
    """classify_command(argv) -> (category_str, [paths])"""

    def test_rm_single_file(self):
        cat, paths = ge.classify_command(["rm", "file.txt"])
        assert cat == "DELETE"
        # path is kept even though the file doesn't exist on disk yet
        assert "file.txt" in paths

    def test_rm_recursive_flag_skipped(self):
        cat, paths = ge.classify_command(["rm", "-rf", "dir/"])
        assert cat == "DELETE"
        assert "-rf" not in paths

    def test_dd_of_extraction(self):
        cat, paths = ge.classify_command(["dd", "if=/dev/zero", "of=/dev/sda", "bs=1M"])
        assert cat == "OVERWRITE"
        assert "/dev/sda" in paths
        # `if=` should NOT be treated as an output path
        assert "/dev/zero" not in paths

    def test_dd_no_of(self):
        cat, paths = ge.classify_command(["dd", "if=/dev/urandom"])
        assert cat == "OVERWRITE"
        assert paths == []

    def test_git_reset_hard(self):
        cat, _ = ge.classify_command(["git", "reset", "--hard", "HEAD~1"])
        assert cat == "DESTRUCTIVE_GIT"

    def test_git_reset_soft_is_not_destructive(self):
        cat, _ = ge.classify_command(["git", "reset", "--soft", "HEAD~1"])
        assert cat == "GIT_OTHER"

    def test_git_clean(self):
        cat, _ = ge.classify_command(["git", "clean", "-fd"])
        assert cat == "DESTRUCTIVE_GIT"

    def test_git_push_force(self):
        cat, _ = ge.classify_command(["git", "push", "--force", "origin", "main"])
        assert cat == "DESTRUCTIVE_GIT"

    def test_git_push_f_short_flag(self):
        cat, _ = ge.classify_command(["git", "push", "-f"])
        assert cat == "DESTRUCTIVE_GIT"

    def test_git_push_non_force(self):
        cat, _ = ge.classify_command(["git", "push", "origin", "main"])
        assert cat == "GIT_OTHER"

    def test_unrecognized_command(self):
        cat, _ = ge.classify_command(["ls", "-la", "/tmp"])
        assert cat == "OTHER"

    def test_empty_argv(self):
        cat, paths = ge.classify_command([])
        assert cat == "OTHER"
        assert paths == []


# ===========================================================================
# 2.  compute_impact_vector()
# ===========================================================================


class TestComputeImpactVectorFiles:
    """Tests against a real temp directory with known file sizes."""

    @pytest.fixture()
    def tmpdir_with_files(self, tmp_path):
        """Creates:
          tmp_path/a.txt   (1 024 bytes)
          tmp_path/b.txt   (2 048 bytes)
          tmp_path/sub/c.txt (4 096 bytes)
        Total: 7 168 bytes, 3 files.
        """
        (tmp_path / "a.txt").write_bytes(b"x" * 1024)
        (tmp_path / "b.txt").write_bytes(b"x" * 2048)
        sub = tmp_path / "sub"
        sub.mkdir()
        (sub / "c.txt").write_bytes(b"x" * 4096)
        return tmp_path

    def test_individual_file_byte_count(self, tmpdir_with_files):
        p = tmpdir_with_files / "a.txt"
        iv = ge.compute_impact_vector([str(p)], str(tmpdir_with_files))
        assert iv["file_count"] == 1
        assert iv["total_bytes"] == 1024

    def test_directory_walk_aggregates_all_files(self, tmpdir_with_files):
        iv = ge.compute_impact_vector(
            [str(tmpdir_with_files)], str(tmpdir_with_files)
        )
        assert iv["file_count"] == 3
        assert iv["total_bytes"] == 1024 + 2048 + 4096

    def test_nonexistent_path_is_ignored(self, tmpdir_with_files):
        iv = ge.compute_impact_vector(
            [str(tmpdir_with_files / "ghost.txt")], str(tmpdir_with_files)
        )
        assert iv["file_count"] == 0
        assert iv["total_bytes"] == 0
        assert iv["targets_existed"] == 0

    def test_targets_existed_counts_real_files(self, tmpdir_with_files):
        a = tmpdir_with_files / "a.txt"
        b = tmpdir_with_files / "b.txt"
        iv = ge.compute_impact_vector(
            [str(a), str(b)], str(tmpdir_with_files)
        )
        assert iv["targets_existed"] == 2

    def test_non_git_category_does_not_report_git_state(self, tmpdir_with_files):
        """Regression: a DELETE command in a dirty repo must not report
        git_uncommitted=True (that would be a false positive)."""
        iv = ge.compute_impact_vector(
            [str(tmpdir_with_files / "a.txt")],
            str(tmpdir_with_files),
            category="DELETE",
        )
        assert iv["git_uncommitted"] is False
        assert iv["git_unpushed"] is False


class TestComputeImpactVectorGit:
    """Tests against a real temp git repo with staged/unstaged changes."""

    @pytest.fixture()
    def dirty_git_repo(self, tmp_path):
        """Initialises a git repo with one committed file, one staged change,
        and one untracked file so git status --porcelain returns 2 entries."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", str(repo)], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config",
                        "user.email", "test@test.com"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config",
                        "user.name", "Test"], check=True, capture_output=True)

        # Commit one file so we have a HEAD
        committed = repo / "committed.txt"
        committed.write_text("original\n")
        subprocess.run(["git", "-C", str(repo), "add", "committed.txt"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"],
                       check=True, capture_output=True)

        # Staged change (modify committed file and git add)
        committed.write_text("modified\n")
        subprocess.run(["git", "-C", str(repo), "add", "committed.txt"],
                       check=True, capture_output=True)

        # Unstaged new file
        (repo / "untracked.txt").write_text("new\n")

        return repo

    def test_git_uncommitted_detected(self, dirty_git_repo):
        iv = ge.compute_impact_vector(
            [], str(dirty_git_repo), category="DESTRUCTIVE_GIT"
        )
        assert iv["git_uncommitted"] is True

    def test_dirty_file_count_grounded_from_git_status(self, dirty_git_repo):
        """When paths=[] but the repo is dirty, DESTRUCTIVE_GIT should
        ground file_count in the porcelain output rather than report 0."""
        iv = ge.compute_impact_vector(
            [], str(dirty_git_repo), category="DESTRUCTIVE_GIT"
        )
        # staged committed.txt + untracked.txt = 2 dirty entries
        assert iv["file_count"] >= 1

    def test_non_destructive_git_category_no_git_info(self, dirty_git_repo):
        iv = ge.compute_impact_vector(
            [], str(dirty_git_repo), category="GIT_OTHER"
        )
        # GIT_OTHER still calls check_git_state; it should see dirty state
        # but because paths=[] and category != DESTRUCTIVE_GIT, file_count
        # stays 0 (no grounding step).
        assert iv["file_count"] == 0


# ===========================================================================
# 3.  record_and_score_drift()
# ===========================================================================


class TestRecordAndScoreDrift:
    """Uses a fake SESSION_FILE via monkeypatch so tests never touch /tmp."""

    @pytest.fixture(autouse=True)
    def patch_session_file(self, tmp_path, monkeypatch):
        session = tmp_path / "guard_session.json"
        monkeypatch.setattr(ge, "SESSION_FILE", session)

    def test_fresh_session_returns_zero(self):
        drift = ge.record_and_score_drift("DELETE")
        assert drift == 0.0

    def test_short_history_below_threshold_returns_zero(self):
        # Fewer than 4 commands -> always 0
        for _ in range(3):
            ge.record_and_score_drift("DELETE")
        drift = ge.record_and_score_drift("OTHER")
        assert drift == 0.0

    def test_coherent_history_low_drift(self):
        # Fill window with same category -> coherence=1 -> drift=0
        for _ in range(8):
            ge.record_and_score_drift("DELETE")
        drift = ge.record_and_score_drift("DELETE")
        assert drift == pytest.approx(0.0, abs=0.05)

    def test_divergent_history_high_drift(self):
        # Window full of "OTHER", then a DELETE -> all non-matching -> drift near 1
        for _ in range(ge.WINDOW_SIZE):
            ge.record_and_score_drift("OTHER")
        drift = ge.record_and_score_drift("DELETE")
        # The DELETE isn't in the window yet when drift is computed,
        # so matches=0 -> coherence=0 -> drift=1.0
        assert drift == pytest.approx(1.0, abs=1e-9)

    def test_window_capped_at_window_size(self, tmp_path):
        for i in range(ge.WINDOW_SIZE + 10):
            ge.record_and_score_drift("DELETE")
        state = json.loads(ge.SESSION_FILE.read_text())
        assert len(state["window"]) == ge.WINDOW_SIZE

    def test_corrupted_session_file_handled_gracefully(self):
        ge.SESSION_FILE.write_text("NOT JSON {{{{")
        drift = ge.record_and_score_drift("DELETE")
        assert drift == 0.0  # fresh window, no crash


# ===========================================================================
# 4.  decide_action() -- threshold boundaries
# ===========================================================================


class TestDecideAction:
    """Verify action tier assignment at and across every threshold boundary."""

    # Thresholds: WARN=0.3, CONFIRM=0.55, BLOCK=0.8

    def test_below_warn_is_allow(self):
        assert ge.decide_action(0.0) == "ALLOW"
        assert ge.decide_action(0.29) == "ALLOW"

    def test_at_warn_boundary(self):
        assert ge.decide_action(ge.RISK_THRESHOLDS["WARN"]) == "WARN"

    def test_just_above_warn_is_warn(self):
        assert ge.decide_action(0.31) == "WARN"

    def test_just_below_confirm_is_warn(self):
        assert ge.decide_action(0.549) == "WARN"

    def test_at_confirm_boundary(self):
        assert ge.decide_action(ge.RISK_THRESHOLDS["CONFIRM"]) == "CONFIRM"

    def test_between_confirm_and_block_is_confirm(self):
        assert ge.decide_action(0.70) == "CONFIRM"

    def test_just_below_block_is_confirm(self):
        assert ge.decide_action(0.799) == "CONFIRM"

    def test_at_block_boundary(self):
        assert ge.decide_action(ge.RISK_THRESHOLDS["BLOCK"]) == "BLOCK"

    def test_above_block_is_block(self):
        assert ge.decide_action(0.95) == "BLOCK"
        assert ge.decide_action(1.0) == "BLOCK"
