"""What the machine looked like when a measurement ran, and whether that run can count.

Standard library only. Every measurement script calls `snapshot()` before it
starts and writes the result into the run's manifest.json, so the conditions are
recorded by the script at run time, not remembered afterwards.

A run is valid only if every check in `problems()` passes. A run that fails a
check is still saved, but under exploratory/ with the reasons written down.
"""

import datetime
import hashlib
import json
import os
import platform
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Processes that hold a model in memory. A second one running during a
# measurement competes for memory bandwidth and makes the numbers worse.
# Matched on the executable, not the arguments: a script whose arguments name
# llama-bench is not llama-bench.
INFERENCE = [
    ("llama-server", lambda exe, cmd, pid: os.path.basename(exe) == "llama-server"),
    ("llama-bench", lambda exe, cmd, pid: os.path.basename(exe) == "llama-bench"),
    ("ollama runner", lambda exe, cmd, pid: os.path.basename(exe) == "ollama" and " runner" in cmd),
    ("mlx_lm.server", lambda exe, cmd, pid: "python" in os.path.basename(exe).lower() and "mlx_lm" in cmd and "server" in cmd),
    # LM Studio loads its llama.cpp and MLX engines as libraries inside its own
    # node worker, so the executable says nothing; the open weights file does.
    ("LM Studio engine", lambda exe, cmd, pid: exe.endswith("/.lmstudio/.internal/utils/node") and pid in _holding),
]


# LM Studio workers holding a model; filled by snapshot().
_holding = {}


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"<failed: {e}>"


def processes():
    """Every process as {pid, ppid, cpu, exe, command}."""
    exes = {}
    for line in sh(["ps", "-axww", "-o", "pid=,comm="]).splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2:
            exes[int(parts[0])] = parts[1]
    out = []
    for line in sh(["ps", "-axww", "-o", "pid=,ppid=,pcpu=,command="]).splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            pid = int(parts[0])
            out.append({"pid": pid, "ppid": int(parts[1]), "cpu": float(parts[2]),
                        "exe": exes.get(pid, ""), "command": parts[3]})
    return out


def ancestors(pid, procs):
    """pid and every process above it: this script, its shell, its terminal."""
    parent = {p["pid"]: p["ppid"] for p in procs}
    found = set()
    while pid and pid not in found:
        found.add(pid)
        pid = parent.get(pid)
    return found


def descendants(pid, procs):
    """pid and every process started under it."""
    found, frontier = {pid}, [pid]
    while frontier:
        parent = frontier.pop()
        for p in procs:
            if p["ppid"] == parent and p["pid"] not in found:
                found.add(p["pid"])
                frontier.append(p["pid"])
    return found


def listener(port):
    """The pid listening on a local TCP port, or None."""
    out = sh(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"])
    pids = [int(x) for x in out.split() if x.isdigit()]
    return pids[0] if pids else None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


def scripts_commit():
    """The benchmark scripts' git commit, and whether the working tree had uncommitted edits."""
    head = sh(["git", "-C", ROOT, "rev-parse", "HEAD"])
    dirty = sh(["git", "-C", ROOT, "status", "--porcelain", "--", "scripts"])
    return {"commit": head, "uncommitted_changes": bool(dirty)}


def version_of(command):
    """`--version` of a known inference binary, from its command line."""
    binary = command.split()[0]
    name = os.path.basename(binary)
    if name in ("llama-server", "llama-bench", "ollama"):
        return sh([binary, "--version"], timeout=20)[:500]
    if "mlx_lm" in command and "python" in name.lower():
        return sh([binary, "-c", "import mlx_lm, mlx.core as mx; print('mlx-lm', mlx_lm.__version__, 'mlx', mx.__version__)"],
                  timeout=60)[:500]
    return None


def snapshot(ports=(), model_file=None):
    """The conditions right now. `ports` are the servers being measured."""
    procs = processes()
    me = ancestors(os.getpid(), procs)
    # Which LM Studio workers hold a model, read once per snapshot. Its llama.cpp
    # engine keeps the .gguf open; its MLX engine reads the weights into memory
    # and closes them, so a worker with an engine loaded and over 1 GB resident
    # counts too (an idle worker maps no engine and holds about 100 MB).
    _holding.clear()
    for p in procs:
        if p["exe"].endswith("/.lmstudio/.internal/utils/node"):
            files = sh(["lsof", "-p", str(p["pid"])], timeout=30)
            rss_kb = int(sh(["ps", "-o", "rss=", "-p", str(p["pid"])]) or 0)
            engine = ".lmstudio/extensions/backends/" in files
            if re.search(r"\.(gguf|safetensors)$", files, re.M) or (engine and rss_kb > 1024 * 1024):
                _holding[p["pid"]] = True
    targets = []
    allowed = set()
    for port in ports:
        pid = listener(port)
        entry = {"port": port, "pid": pid}
        if pid:
            tree = descendants(pid, procs)
            allowed |= tree
            entry["processes"] = [
                {"pid": p["pid"], "command": p["command"], "version": version_of(p["command"])}
                for p in procs if p["pid"] in tree
            ]
        targets.append(entry)
    inference = [
        {"kind": kind, "pid": p["pid"], "command": p["command"], "part_of_target": p["pid"] in allowed}
        for p in procs if p["pid"] not in me for kind, match in INFERENCE if match(p["exe"], p["command"], p["pid"])
    ]
    busiest = sorted((p for p in procs if p["pid"] not in allowed and p["pid"] not in me),
                     key=lambda p: -p["cpu"])[:8]
    pm = sh(["pmset", "-g"])
    # macOS 26 calls it `powermode` (0 automatic, 1 low power, 2 high power);
    # older releases `lowpowermode` (1 on).
    mode = re.search(r"^\s*powermode\s+(\d)", pm, re.M)
    low_power = re.search(r"^\s*lowpowermode\s+(\d)", pm, re.M)
    snap = {
        "taken_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "machine": {
            "model": sh(["sysctl", "-n", "hw.model"]),
            "chip": sh(["sysctl", "-n", "machdep.cpu.brand_string"]),
            "memory_bytes": int(sh(["sysctl", "-n", "hw.memsize"]) or 0),
            "macos": sh(["sw_vers", "-productVersion"]),
            "macos_build": sh(["sw_vers", "-buildVersion"]),
            "python": platform.python_version(),
        },
        "power": {
            "battery": sh(["pmset", "-g", "batt"]),
            "on_ac": "AC Power" in sh(["pmset", "-g", "batt"]),
            "power_mode": int(mode.group(1)) if mode else None,
            "low_power_mode": (1 if int(mode.group(1)) == 1 else 0) if mode else int(low_power.group(1)) if low_power else None,
            "thermal": sh(["pmset", "-g", "therm"]),
        },
        "targets": targets,
        "inference_processes": inference,
        "busiest_other_processes": [{"pid": p["pid"], "cpu": p["cpu"], "command": p["command"][:200]} for p in busiest],
        "scripts": scripts_commit(),
    }
    if model_file:
        snap["model_file"] = model_identity(model_file)
    return snap


def model_identity(path):
    """The weights' hash: one file (GGUF), or every file of a model folder (MLX).

    For a folder, `sha256` is the hash of the sorted "name sha256" lines, so two
    folders with the same files give the same value. Hidden entries (download
    caches) are skipped.
    """
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        return {"path": path, "bytes": os.path.getsize(path), "sha256": sha256(path)}
    files = {}
    for root, dirs, names in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if not name.startswith("."):
                full = os.path.join(root, name)
                files[os.path.relpath(full, path)] = sha256(full)
    listing = "".join(f"{name} {digest}\n" for name, digest in sorted(files.items()))
    return {"path": path, "bytes": sum(os.path.getsize(os.path.join(path, n)) for n in files),
            "sha256": hashlib.sha256(listing.encode()).hexdigest(), "files": files}


def cpu_times():
    """CPU seconds each process has used so far, with its command line."""
    out = {}
    for line in sh(["ps", "-axww", "-o", "pid=,time=,command="]).splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        # [[dd-]hh:]mm:ss.ss
        days, _, clock = parts[1].rpartition("-")
        seconds = 0.0
        for field in clock.split(":"):
            seconds = seconds * 60 + float(field)
        out[int(parts[0])] = (seconds + int(days or 0) * 86400, parts[2])
    return out


def cpu_during(start, end, elapsed, exclude):
    """Average CPU % of every other process between two `cpu_times()` readings, busiest first.

    This is what competed with the measurement while it ran. ps's own %CPU is a
    decaying average, so read right after a run it shows macOS reacting to the
    run (power accounting) rather than anything that ran alongside it.
    """
    rows = []
    for pid, (t1, cmd) in end.items():
        if pid in exclude:
            continue
        t0 = start.get(pid, (0.0, cmd))[0]
        rows.append({"pid": pid, "cpu": round(100 * (t1 - t0) / elapsed, 1), "command": cmd[:200]})
    return sorted(rows, key=lambda r: -r["cpu"])[:8]


def busy_problems(during):
    hot = [p for p in during if p["cpu"] >= 50]
    if not hot:
        return []
    return ["another process was busy during the run: " +
            "; ".join(f"{p['command'][:60]} at {p['cpu']:.0f}% CPU on average" for p in hot)]


def own_tree():
    """This script, what launched it and what it launched."""
    procs = processes()
    return ancestors(os.getpid(), procs) | descendants(os.getpid(), procs)


def problems(snap, require_model_file=True, check_busy=True):
    """Why a run under these conditions cannot count, or [] if it can."""
    out = []
    if not snap["power"]["on_ac"]:
        out.append("the Mac is on battery")
    # Charging heats the machine and shares its power budget. A sustained run
    # at 82% and charging settled near 72 tok/s; the same run fully charged, 87.
    if re.search(r";\s*charging;", snap["power"]["battery"]):
        out.append("the battery is charging; wait until it is charged")
    if snap["power"]["low_power_mode"] != 0:
        out.append("Low Power Mode is on or unknown")
    if "No thermal warning level has been recorded" not in snap["power"]["thermal"] and \
            "No performance warning level has been recorded" not in snap["power"]["thermal"]:
        out.append("the system reports a thermal or performance warning")
    for t in snap["targets"]:
        if not t["pid"]:
            out.append(f"nothing is listening on port {t['port']}")
    others = [p for p in snap["inference_processes"] if not p["part_of_target"]]
    if others:
        out.append("another model process is running: " + "; ".join(f"{p['kind']} (pid {p['pid']})" for p in others))
    hot = [p for p in snap["busiest_other_processes"] if p["cpu"] >= 50]
    if hot and check_busy:
        out.append("another process is busy: " + "; ".join(f"{p['command'][:60]} at {p['cpu']:.0f}% CPU" for p in hot))
    if snap["scripts"]["uncommitted_changes"] or not re.fullmatch(r"[0-9a-f]{40}", snap["scripts"]["commit"]):
        out.append("the benchmark scripts have uncommitted changes, so the code that ran is not recorded")
    if require_model_file and "model_file" not in snap:
        out.append("no --model-file given, so which weights ran is not recorded")
    return out


def run_dir(name, valid):
    """A new folder for one run: runs/<UTC time>-<name> if valid, else exploratory/."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(ROOT, "runs" if valid else "exploratory", f"{stamp}-{name}")
    os.makedirs(path)
    return path


def write_manifest(path, manifest):
    with open(os.path.join(path, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
