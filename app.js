/**
 * Grounded Intent Guard — Interactive Terminal & Engine Simulation
 * Pure JavaScript, 100% deterministic simulation of guard_engine.py.
 */

// Global Engine Config & State
const CONFIG = {
  weights: { impact: 0.45, drift: 0.25, irreversibility: 0.30 },
  thresholds: { WARN: 0.30, CONFIRM: 0.55, BLOCK: 0.80 },
  windowSize: 12
};

// Session command category window (mimics GUARD_SESSION_FILE)
let sessionWindow = ["OTHER", "OTHER", "GIT_OTHER", "OTHER", "GIT_OTHER", "OTHER"];

// Virtual System States
const VFS_SCENARIOS = {
  "dirty-git": {
    name: "Dirty Git Repo (~/project)",
    cwd: "~/project",
    files: {
      "app.py": { size: 4096, uncommitted: true, unpushed: true },
      "models.py": { size: 8192, uncommitted: true, unpushed: false },
      "config.json": { size: 1024, uncommitted: false, unpushed: false }
    },
    git: {
      inside: true,
      uncommitted: true,
      unpushed: true,
      dirtyFiles: ["app.py (modified)", "models.py (staged)"]
    },
    trashAvailable: true,
    snapshotAvailable: false
  },
  "blockdev": {
    name: "Production Server Root (/)",
    cwd: "/",
    isBlockDevice: true,
    blockDeviceName: "/dev/sda",
    blockDeviceBytes: 1024 * 1024 * 1024 * 512, // 512 GB
    git: { inside: false, uncommitted: false, unpushed: false, dirtyFiles: [] },
    trashAvailable: false,
    snapshotAvailable: false
  },
  "large-build": {
    name: "Build Cache Directory (~/project)",
    cwd: "~/project",
    dirs: {
      "./build": { fileCount: 3200, totalBytes: 480 * 1024 * 1024 }
    },
    git: { inside: true, uncommitted: false, unpushed: false, dirtyFiles: [] },
    trashAvailable: true,
    snapshotAvailable: false
  },
  "empty-dir": {
    name: "Clean Workspace (~/project)",
    cwd: "~/project",
    files: {},
    dirs: {},
    git: { inside: true, uncommitted: false, unpushed: false, dirtyFiles: [] },
    trashAvailable: true,
    snapshotAvailable: false
  },
  "system-dir": {
    name: "System Root (/)",
    cwd: "/",
    dirs: {
      "/etc": { fileCount: 1420, totalBytes: 85 * 1024 * 1024, crossesMount: true, heldBy: ["systemd", "sshd"] }
    },
    git: { inside: false, uncommitted: false, unpushed: false, dirtyFiles: [] },
    trashAvailable: false,
    snapshotAvailable: false
  },
  "drift-test": {
    name: "Active Dev Session (~/project)",
    cwd: "~/project",
    files: { "temp.txt": { size: 500, uncommitted: false, unpushed: false } },
    dirs: {},
    git: { inside: true, uncommitted: false, unpushed: false, dirtyFiles: [] },
    trashAvailable: true,
    snapshotAvailable: false
  }
};

let currentVFSKey = "dirty-git";
let activeConfirmationCallback = null;

// ==========================================================================
// Core Deterministic Logic (Faithful Mirror of guard_engine.py)
// ==========================================================================

const CATEGORY_RULES = [
  ["DELETE", new Set(["rm", "shred", "unlink"])],
  ["OVERWRITE", new Set(["dd", "truncate"])],
  ["PERMISSION", new Set(["chmod", "chown", "chgrp"])],
  ["MOVE", new Set(["mv"])]
];

function classifyCommand(cmdStr) {
  const parts = cmdStr.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { category: "OTHER", paths: [], raw: cmdStr };

  const cmd = parts[0];
  const args = parts.slice(1);

  if (cmd === "git") {
    const rest = args;
    if (rest[0] === "reset" && rest.includes("--hard")) {
      return { category: "DESTRUCTIVE_GIT", paths: extractPaths(rest.slice(1)), raw: cmdStr };
    }
    if (rest[0] === "clean") {
      return { category: "DESTRUCTIVE_GIT", paths: extractPaths(rest.slice(1)), raw: cmdStr };
    }
    if (rest[0] === "push" && (rest.includes("--force") || rest.includes("-f"))) {
      return { category: "DESTRUCTIVE_GIT", paths: extractPaths(rest.slice(1)), raw: cmdStr };
    }
    return { category: "GIT_OTHER", paths: extractPaths(rest), raw: cmdStr };
  }

  if (cmd === "dd") {
    const ofPaths = [];
    for (const a of args) {
      if (a.startsWith("of=")) ofPaths.push(a.slice(3));
    }
    return { category: "OVERWRITE", paths: ofPaths, raw: cmdStr };
  }

  for (const [cat, names] of CATEGORY_RULES) {
    if (names.has(cmd)) {
      return { category: cat, paths: extractPaths(args), raw: cmdStr };
    }
  }

  return { category: "OTHER", paths: extractPaths(args), raw: cmdStr };
}

function extractPaths(args) {
  return args.filter(a => !a.startsWith("-"));
}

function computeImpactVector(paths, category, vfs) {
  let fileCount = 0;
  let totalBytes = 0;
  let targetsExisted = 0;
  let isBlockDevice = false;
  let crossesMount = false;
  let heldByProcess = [];

  // 1. Block Device check
  if (paths.some(p => p.startsWith("/dev/sd") || p.startsWith("/dev/disk") || p.startsWith("/dev/nvme")) || (vfs.isBlockDevice && category === "OVERWRITE")) {
    isBlockDevice = true;
    totalBytes = vfs.blockDeviceBytes || (1024 * 1024 * 1024 * 512);
    fileCount = 1;
    targetsExisted = 1;
  } else {
    // Check virtual directory
    for (const p of paths) {
      if (vfs.dirs && vfs.dirs[p]) {
        const d = vfs.dirs[p];
        fileCount += d.fileCount || 0;
        totalBytes += d.totalBytes || 0;
        if (d.crossesMount) crossesMount = true;
        if (d.heldBy) heldByProcess.push(...d.heldBy);
        targetsExisted++;
      } else if (vfs.files && vfs.files[p]) {
        const f = vfs.files[p];
        fileCount += 1;
        totalBytes += f.size || 0;
        targetsExisted++;
      }
    }
  }

  // 2. Git State grounding (only for GIT categories)
  let gitUncommitted = false;
  let gitUnpushed = false;
  let dirtyFiles = [];

  if (category === "DESTRUCTIVE_GIT" || category === "GIT_OTHER") {
    if (vfs.git && vfs.git.inside) {
      gitUncommitted = vfs.git.uncommitted;
      gitUnpushed = vfs.git.unpushed;
      dirtyFiles = vfs.git.dirtyFiles || [];
    }
  }

  // Ground git reset/clean with real dirty files when no explicit path was provided
  if (category === "DESTRUCTIVE_GIT" && targetsExisted === 0 && dirtyFiles.length > 0) {
    fileCount = dirtyFiles.length;
    totalBytes = dirtyFiles.length * 4096;
    targetsExisted = dirtyFiles.length;
  }

  return {
    file_count: fileCount,
    total_bytes: totalBytes,
    crosses_mount_boundary: crossesMount,
    git_uncommitted: gitUncommitted,
    git_unpushed: gitUnpushed,
    held_by_process: heldByProcess,
    targets_existed: targetsExisted,
    is_block_device: isBlockDevice
  };
}

function computeRecoverability(impact, vfs) {
  let score = 0.0;
  if (!impact.git_uncommitted) score += 0.3;
  if (!impact.git_unpushed) score += 0.2;
  if (vfs.trashAvailable) score += 0.3;
  if (vfs.snapshotAvailable) score += 0.2;
  return Math.min(score, 1.0);
}

function recordAndScoreDrift(category) {
  const window = sessionWindow;
  let drift = 0.0;

  if (window.length < 4) {
    drift = 0.0;
  } else {
    const matches = window.filter(c => c === category).length;
    const coherence = matches / window.length;
    drift = 1.0 - coherence;
  }

  sessionWindow.push(category);
  if (sessionWindow.length > CONFIG.windowSize) {
    sessionWindow = sessionWindow.slice(-CONFIG.windowSize);
  }

  return { drift, coherence: 1.0 - drift };
}

function computeRiskScore(impact, drift, recoverability) {
  if (impact.is_block_device) {
    return { score: 0.95, impactSignal: 1.0, irreversibility: 1.0 };
  }

  const irreversibility = 1.0 - recoverability;
  let impactSignal = 0.0;

  if (impact.file_count > 0) {
    impactSignal += 0.15;
    impactSignal += Math.min(impact.file_count / 500.0, 1.0) * 0.35;
    impactSignal += Math.min(impact.total_bytes / (500 * 1024 * 1024), 1.0) * 0.20;
  }
  if (impact.crosses_mount_boundary) impactSignal += 0.10;
  if (impact.held_by_process && impact.held_by_process.length > 0) impactSignal += 0.10;
  impactSignal = Math.min(impactSignal, 1.0);

  const score = (CONFIG.weights.impact * impactSignal)
              + (CONFIG.weights.drift * drift)
              + (CONFIG.weights.irreversibility * irreversibility);

  return {
    score: Math.min(score, 1.0),
    impactSignal,
    irreversibility
  };
}

function decideAction(score) {
  if (score >= CONFIG.thresholds.BLOCK) return "BLOCK";
  if (score >= CONFIG.thresholds.CONFIRM) return "CONFIRM";
  if (score >= CONFIG.thresholds.WARN) return "WARN";
  return "ALLOW";
}

const SUGGESTIONS = {
  "DELETE": "Consider `trash-put` instead of `rm`, or add `-i` for per-file confirmation.",
  "OVERWRITE": "Test with a small block count first, and double-check `of=` before running.",
  "PERMISSION": "Preview with `chmod --changes -R` first; scope to a subdirectory before recursing.",
  "MOVE": "Add `-i` (or `-n`) so an existing destination file isn't silently clobbered.",
  "DESTRUCTIVE_GIT": "Run `git stash` (or push your branch) before resetting/cleaning."
};

function generateExplanation(category, impact, drift, recoverability, score) {
  const lines = [];
  if (impact.file_count > 0) {
    const mb = impact.total_bytes / (1024 * 1024);
    if (impact.is_block_device) {
      lines.push(`Target is a raw block device (~${Math.round(mb)} MB) -- overwrites an entire disk partition.`);
    } else {
      lines.push(`Affects ${impact.file_count} file(s), ${mb.toFixed(1)} MB.`);
    }
  }
  if (impact.git_uncommitted) lines.push("Includes uncommitted git changes.");
  if (impact.git_unpushed) lines.push("Includes commits not yet pushed to a remote.");
  if (impact.crosses_mount_boundary) lines.push("Target crosses a filesystem mount boundary.");
  if (impact.held_by_process && impact.held_by_process.length > 0) {
    lines.push(`Currently open by: ${impact.held_by_process.join(", ")}.`);
  }
  if (drift > 0.6) {
    lines.push(`Sharp departure from your last ${CONFIG.windowSize} commands (category: ${category}).`);
  }
  lines.push(`Recoverability score: ${recoverability.toFixed(2)}/1.0 (higher = easier to undo).`);
  lines.push(`Overall risk score: ${score.toFixed(2)}/1.0.`);

  return lines.length ? lines.join("\n") : "No specific impact detected.";
}

// ==========================================================================
// UI Rendering & Terminal Interaction
// ==========================================================================

const terminalHistory = document.getElementById("terminal-history");
const terminalInput = document.getElementById("terminal-input");
const terminalScreen = document.getElementById("terminal-screen");
const terminalCwd = document.getElementById("terminal-cwd");
const vfsLabel = document.getElementById("vfs-label");

function evaluateAndRender(cmdStr, executeInTerm = true) {
  const vfs = VFS_SCENARIOS[currentVFSKey];
  const { category, paths } = classifyCommand(cmdStr);
  const impact = computeImpactVector(paths, category, vfs);
  const recoverability = computeRecoverability(impact, vfs);
  
  // Calculate drift without mutating window for preview, or mutate on run
  let driftObj;
  if (executeInTerm) {
    driftObj = recordAndScoreDrift(category);
  } else {
    // preview
    const matches = sessionWindow.filter(c => c === category).length;
    const coherence = sessionWindow.length >= 4 ? matches / sessionWindow.length : 1.0;
    driftObj = { drift: sessionWindow.length >= 4 ? 1.0 - coherence : 0.0, coherence };
  }

  const { score, impactSignal, irreversibility } = computeRiskScore(impact, driftObj.drift, recoverability);
  const action = decideAction(score);
  const explanation = generateExplanation(category, impact, driftObj.drift, recoverability, score);
  const suggestion = SUGGESTIONS[category] || "Re-check the target and consider a --dry-run first.";

  // Update Right Panel Telemetry
  updateTelemetryUI({
    category,
    paths,
    impact,
    recoverability,
    drift: driftObj.drift,
    coherence: driftObj.coherence,
    score,
    impactSignal,
    irreversibility,
    action,
    explanation,
    suggestion
  });

  return { category, impact, recoverability, drift: driftObj.drift, score, action, explanation, suggestion };
}

function updateTelemetryUI(res) {
  // 1. Action Badge
  const badge = document.getElementById("action-tier-badge");
  badge.className = `tier-badge ${res.action}`;
  badge.textContent = res.action;

  // 2. Risk Score & Bar
  document.getElementById("risk-score-value").textContent = `${res.score.toFixed(2)} / 1.00`;
  const pct = Math.min(Math.max(res.score * 100, 3), 100);
  document.getElementById("risk-bar-fill").style.width = `${pct}%`;

  // 3. Formula breakdown
  document.getElementById("f-impact").textContent = res.impactSignal.toFixed(2);
  document.getElementById("f-drift").textContent = res.drift.toFixed(2);
  document.getElementById("f-irrev").textContent = res.irreversibility.toFixed(2);
  document.getElementById("f-total").textContent = res.score.toFixed(2);

  // 4. Signals
  document.getElementById("vec-category").textContent = res.category;
  document.getElementById("vec-target-path").innerHTML = res.paths.length 
    ? `Target: <code>${res.paths.join(", ")}</code>`
    : `Target: <em>(implicit working tree)</em>`;

  document.getElementById("vec-file-count").textContent = `${res.impact.file_count} file(s)`;
  document.getElementById("vec-total-bytes").textContent = `Total Size: ${(res.impact.total_bytes / (1024 * 1024)).toFixed(1)} MB`;

  const gitEl = document.getElementById("vec-git-status");
  const gitSub = document.getElementById("vec-git-details");
  if (res.impact.git_uncommitted) {
    gitEl.textContent = "Dirty (Uncommitted Changes)";
    gitEl.className = "signal-main text-red";
    gitSub.textContent = "Uncommitted: True • Unpushed: " + (res.impact.git_unpushed ? "True" : "False");
  } else if (res.impact.git_unpushed) {
    gitEl.textContent = "Unpushed Commits";
    gitEl.className = "signal-main text-amber";
    gitSub.textContent = "Uncommitted: False • Unpushed: True";
  } else {
    gitEl.textContent = "Clean / Unaffected";
    gitEl.className = "signal-main text-emerald";
    gitSub.textContent = "Uncommitted: False • Unpushed: False";
  }

  document.getElementById("vec-drift-score").textContent = `${res.drift.toFixed(2)} (${res.drift > 0.5 ? "Divergent" : "Coherent"})`;
  document.getElementById("drift-coherence-stat").textContent = `Coherence: ${Math.round(res.coherence * 100)}%`;

  // 5. Drift Tokens
  const driftContainer = document.getElementById("drift-tokens-container");
  driftContainer.innerHTML = "";
  sessionWindow.forEach((cat, idx) => {
    const tok = document.createElement("span");
    tok.className = `drift-token ${idx === sessionWindow.length - 1 ? "active" : ""}`;
    tok.textContent = cat;
    driftContainer.appendChild(tok);
  });

  // 6. Explanation
  document.getElementById("exp-text").textContent = res.explanation;
  document.getElementById("exp-suggestion").innerHTML = `<strong>Suggested Alternative:</strong> ${res.suggestion}`;
}

function appendToTerminal(cmdStr, res) {
  const item = document.createElement("div");
  item.className = "history-item";

  const cmdRow = document.createElement("div");
  cmdRow.className = "history-cmd-row";
  cmdRow.innerHTML = `<span class="history-prompt">dev@grounded-host:${VFS_SCENARIOS[currentVFSKey].cwd}$</span> <span class="history-cmd">${escapeHtml(cmdStr)}</span>`;
  item.appendChild(cmdRow);

  const out = document.createElement("div");
  out.className = `history-output ${res.action.toLowerCase()}`;

  if (res.action === "ALLOW") {
    out.innerHTML = `<span class="text-emerald">[guard] ALLOW</span> — risk=${res.score.toFixed(2)} (within safe threshold). Command proceeded silently.`;
    item.appendChild(out);
    terminalHistory.appendChild(item);
    scrollTerminal();
  } else if (res.action === "WARN") {
    out.innerHTML = `<span class="text-amber">[guard] ${res.category} risk=${res.score.toFixed(2)} action=WARN</span>\n${escapeHtml(res.explanation)}\n<span class="text-dim">Suggested alternative: ${escapeHtml(res.suggestion)}</span>\n<span class="text-emerald">Proceeding automatically with warning logged.</span>`;
    item.appendChild(out);
    terminalHistory.appendChild(item);
    scrollTerminal();
  } else if (res.action === "BLOCK") {
    out.innerHTML = `<span class="text-red">[guard] ${res.category} risk=${res.score.toFixed(2)} action=BLOCK</span>\n${escapeHtml(res.explanation)}\n<span class="text-amber">Suggested alternative: ${escapeHtml(res.suggestion)}</span>\n<span class="text-red"><strong>[guard] Blocked. Command suppressed (exit 1).</strong></span>`;
    item.appendChild(out);
    terminalHistory.appendChild(item);
    scrollTerminal();
  } else if (res.action === "CONFIRM") {
    out.innerHTML = `<span class="text-orange">[guard] ${res.category} risk=${res.score.toFixed(2)} action=CONFIRM</span>\n${escapeHtml(res.explanation)}\n<span class="text-dim">Suggested alternative: ${escapeHtml(res.suggestion)}</span>\n<span class="text-orange"><strong>[guard] Proceed with this ${res.category} anyway? [y/N]</strong></span>`;
    item.appendChild(out);
    terminalHistory.appendChild(item);
    scrollTerminal();

    // Enable interactive confirmation mode
    enterConfirmationMode(item, res);
  }
}

function enterConfirmationMode(parentItem, res) {
  terminalInput.placeholder = "Answer [y/N] to confirm or abort...";
  activeConfirmationCallback = (answer) => {
    const isYes = answer.trim().toLowerCase() === "y";
    const answerLine = document.createElement("div");
    answerLine.className = "history-output";
    if (isYes) {
      answerLine.innerHTML = `<span class="text-emerald">User confirmed [y]. Command executed.</span>`;
    } else {
      answerLine.innerHTML = `<span class="text-red">Aborted by user [N]. Command suppressed (exit 1).</span>`;
    }
    parentItem.appendChild(answerLine);
    activeConfirmationCallback = null;
    terminalInput.placeholder = "Type a command and press Enter...";
    scrollTerminal();
  };
}

function scrollTerminal() {
  terminalScreen.scrollTop = terminalScreen.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ==========================================================================
// Event Listeners & Interactive Wiring
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  // Initial evaluation
  evaluateAndRender("git reset --hard HEAD~1", false);

  // Terminal Input Submission
  terminalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = terminalInput.value.trim();
      if (!val) return;

      if (activeConfirmationCallback) {
        activeConfirmationCallback(val);
        terminalInput.value = "";
        return;
      }

      if (val === "clear") {
        terminalHistory.innerHTML = "";
        terminalInput.value = "";
        return;
      }

      const res = evaluateAndRender(val, true);
      appendToTerminal(val, res);
      terminalInput.value = "";
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      terminalHistory.innerHTML = "";
    }
  });

  // Clear Terminal Button
  document.getElementById("btn-clear-term").addEventListener("click", () => {
    terminalHistory.innerHTML = "";
    terminalInput.focus({ preventScroll: true });
  });

  // Scenario Buttons
  const scenarioBtns = document.querySelectorAll(".scenario-btn");
  scenarioBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      scenarioBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const cmd = btn.getAttribute("data-cmd");
      const vfsKey = btn.getAttribute("data-vfs");

      currentVFSKey = vfsKey;
      vfsLabel.textContent = `VFS: ${VFS_SCENARIOS[vfsKey].name}`;
      terminalCwd.textContent = VFS_SCENARIOS[vfsKey].cwd;

      if (cmd === "drift-burst") {
        // Run burst of dev commands to fill history with OTHER
        sessionWindow = ["OTHER", "OTHER", "OTHER", "OTHER", "OTHER", "OTHER", "OTHER", "OTHER", "OTHER", "OTHER"];
        const burstCmd = "rm -rf ./important-db";
        terminalInput.value = burstCmd;
        const res = evaluateAndRender(burstCmd, true);
        appendToTerminal(burstCmd, res);
      } else {
        terminalInput.value = cmd;
        const res = evaluateAndRender(cmd, true);
        appendToTerminal(cmd, res);
      }
      terminalInput.focus({ preventScroll: true });
    });
  });

  // Sliders for Signal Weights
  const sImpact = document.getElementById("slider-w-impact");
  const sDrift = document.getElementById("slider-w-drift");
  const sIrrev = document.getElementById("slider-w-irrev");

  function syncWeights() {
    CONFIG.weights.impact = parseFloat(sImpact.value);
    CONFIG.weights.drift = parseFloat(sDrift.value);
    CONFIG.weights.irreversibility = parseFloat(sIrrev.value);

    document.getElementById("val-w-impact").textContent = sImpact.value;
    document.getElementById("val-w-drift").textContent = sDrift.value;
    document.getElementById("val-w-irrev").textContent = sIrrev.value;

    const currentCmd = terminalInput.value || "git reset --hard HEAD~1";
    evaluateAndRender(currentCmd, false);
  }

  sImpact.addEventListener("input", syncWeights);
  sDrift.addEventListener("input", syncWeights);
  sIrrev.addEventListener("input", syncWeights);

  // Sliders for Threshold Cutoffs
  const sWarn = document.getElementById("slider-th-warn");
  const sConfirm = document.getElementById("slider-th-confirm");
  const sBlock = document.getElementById("slider-th-block");

  function syncThresholds() {
    CONFIG.thresholds.WARN = parseFloat(sWarn.value);
    CONFIG.thresholds.CONFIRM = parseFloat(sConfirm.value);
    CONFIG.thresholds.BLOCK = parseFloat(sBlock.value);

    document.getElementById("val-th-warn").textContent = sWarn.value;
    document.getElementById("val-th-confirm").textContent = sConfirm.value;
    document.getElementById("val-th-block").textContent = sBlock.value;

    const currentCmd = terminalInput.value || "git reset --hard HEAD~1";
    evaluateAndRender(currentCmd, false);
  }

  sWarn.addEventListener("input", syncThresholds);
  sConfirm.addEventListener("input", syncThresholds);
  sBlock.addEventListener("input", syncThresholds);

  // Quickstart Tabs
  const qsTabs = document.querySelectorAll(".qs-tab");
  qsTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      qsTabs.forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".qs-content").forEach(c => c.classList.remove("active"));

      tab.classList.add("active");
      const targetId = `tab-${tab.getAttribute("data-tab")}`;
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add("active");
    });
  });
});

// Toast Helper
function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2800);
}

// Copy Code Helpers
function copyRaw(text) {
  navigator.clipboard.writeText(text);
  showToast("Copied command to clipboard!");
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.innerText.replace(/^\$ /gm, '').trim();
  navigator.clipboard.writeText(text);
  showToast("Copied command to clipboard!");
}

// High-Res Architecture Diagram Download Handlers (Strictly under 300 KB)
function downloadDiagramSVG() {
  const svgEl = document.getElementById("architecture-diagram-svg");
  if (!svgEl) return;
  const serializer = new XMLSerializer();
  let source = serializer.serializeToString(svgEl);

  if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
    source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "grounded-intent-guard-architecture.svg";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const sizeKb = Math.round(blob.size / 1024);
  showToast(`Downloaded Vector SVG (${sizeKb} KB, Infinite Quality)!`);
}

function downloadDiagramPNG() {
  const svgEl = document.getElementById("architecture-diagram-svg");
  if (!svgEl) return;

  const serializer = new XMLSerializer();
  let source = serializer.serializeToString(svgEl);

  if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
    source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();

  img.onload = function() {
    // 1.5x HD Resolution: 1650 x 930 for razor-sharp vector rasterization
    const scale = 1.5;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(1100 * scale);
    canvas.height = Math.round(620 * scale);
    const ctx = canvas.getContext("2d");

    // Pure white crisp background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Export as high-quality JPEG (0.92) to strictly keep file size ~120KB - 220KB (well under 300 KB)
    canvas.toBlob(function(blob) {
      if (!blob) return;
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = "grounded-intent-guard-architecture.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      URL.revokeObjectURL(url);
      const sizeKb = Math.round(blob.size / 1024);
      showToast(`Downloaded High-Quality Image (${sizeKb} KB, Ultra-Crisp)!`);
    }, "image/jpeg", 0.92);
  };

  img.src = url;
}

