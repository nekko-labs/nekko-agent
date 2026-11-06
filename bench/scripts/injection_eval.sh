#!/usr/bin/env bash
# Prompt injection evals with a real model (#1867, part 2). Start the model's
# OpenAI-compatible server first, then:
#
#   bench/scripts/injection_eval.sh --name qwen3-8b-q4km \
#     --base-url http://127.0.0.1:18181/v1 --model qwen3-8b \
#     --model-file ~/.lmstudio/models/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf \
#     --server-cmd "llama-server -m <file> --port 18181 --jinja -c 32768 -ngl 99" [--runs 10]
#
# Writes bench/injection/runs/<date>-<name>/ (runs.jsonl, manifest.json,
# summary.json, summary.md) and copies it to ~/nekko-benchmarks/injection/.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
runs=10; modes="guardrails,yolo"; turn_seconds=300; injection=blunt
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --base-url) base_url="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --model-file) model_file="$2"; shift 2 ;;
    --server-cmd) server_cmd="$2"; shift 2 ;;
    --runs) runs="$2"; shift 2 ;;
    --modes) modes="$2"; shift 2 ;;
    --turn-seconds) turn_seconds="$2"; shift 2 ;;
    --injection) injection="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
: "${name:?--name}" "${base_url:?--base-url}" "${model:?--model}" "${model_file:?--model-file}" "${server_cmd:?--server-cmd}"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--name: letters, digits, . _ - only" >&2; exit 2; }
[[ "$injection" == blunt || "$injection" == subtle ]] || { echo "--injection: blunt or subtle" >&2; exit 2; }
out="$root/bench/injection/runs/$(date +%Y-%m-%d)-$name"
[ -e "$out" ] && { echo "$out exists; pick another --name" >&2; exit 2; }
mkdir -p "$out"
curl -sf "${base_url%/v1}/health" >/dev/null || curl -sf "$base_url/models" >/dev/null || { echo "no server at $base_url" >&2; exit 1; }
power="$(pmset -g batt 2>/dev/null | head -1 || true)"
python3 -I - "$out/manifest.json" <<PY
import json, sys, subprocess, platform, datetime, os
def run(*a):
    try:
        r = subprocess.run(a, capture_output=True, text=True, timeout=600)
        return (r.stdout.strip() or r.stderr.strip()).splitlines()[0] if (r.stdout.strip() or r.stderr.strip()) else ""
    except Exception as e: return f"unavailable: {e}"
json.dump({
  "what": "Prompt injection evals with a real model (#1867, part 2)",
  "started": datetime.datetime.now().astimezone().isoformat(),
  "name": "$name", "model": "$model", "modelFile": os.path.expanduser("$model_file").replace(os.path.expanduser("~"), "~", 1),
  "modelSha256": run("shasum", "-a", "256", os.path.expanduser("$model_file")).split(" ")[0],
  "server": {"baseUrl": "$base_url", "command": """$server_cmd""", "version": run(*"""$server_cmd""".split()[:1], "--version")},
  "injection": "$injection",
  "runs": int("$runs"), "modes": "$modes".split(","), "turnSeconds": int("$turn_seconds"),
  "repo": {"commit": run("git", "-C", "$root", "rev-parse", "HEAD"), "dirty": bool(run("git", "-C", "$root", "status", "--porcelain"))},
  "machine": {"chip": run("sysctl", "-n", "machdep.cpu.brand_string"), "memoryBytes": run("sysctl", "-n", "hw.memsize"), "os": platform.platform()},
  "power": """$power""",
}, open(sys.argv[1], "w"), indent=2)
PY
cd "$root"
NEKKO_EVAL_BASE_URL="$base_url" NEKKO_EVAL_MODEL="$model" NEKKO_EVAL_RUNS="$runs" NEKKO_EVAL_MODES="$modes" \
NEKKO_EVAL_TURN_SECONDS="$turn_seconds" NEKKO_EVAL_OUT="$out" NEKKO_EVAL_INJECTION="$injection" \
  cargo test -p nekkod --test daemon injection::real_model_injection_evals -- --ignored --nocapture 2>&1 | tee "$out/test.log" | grep -E '^\{"source"' | cut -c1-200 || true
python3 -I "$root/bench/scripts/injection_summary.py" "$out"
mkdir -p "$HOME/nekko-benchmarks/injection"
cp -R "$out" "$HOME/nekko-benchmarks/injection/"
echo "saved $out and ~/nekko-benchmarks/injection/$(basename "$out")"
