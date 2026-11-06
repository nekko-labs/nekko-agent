#!/usr/bin/env python3
"""Run llama.cpp's own llama-bench and file the result with its conditions.

llama-bench measures the engine with no HTTP server and no app in front: the
ceiling the servers are compared against. No server should beat it on the same
build, file and settings.

Example:
    python3 bench/scripts/llama_bench.py --name llama-bench-b11224-qwen3-8b \
        --binary ~/.nekko-agent/engine/macos-arm64-metal/llama-b11224/llama-bench \
        --model-file ~/.nekko-agent/models/chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf \
        -- -ngl 999

Anything after -- goes to llama-bench as is.
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conditions  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True)
    ap.add_argument("--binary", required=True)
    ap.add_argument("--model-file", required=True)
    ap.add_argument("--prompt-tokens", type=int, default=512, help="llama-bench -p")
    ap.add_argument("--gen-tokens", type=int, default=256, help="llama-bench -n")
    ap.add_argument("--repetitions", type=int, default=5, help="llama-bench -r")
    ap.add_argument("--notes", default="")
    ap.add_argument("--exploratory", action="store_true")
    ap.add_argument("extra", nargs="*", help="extra llama-bench arguments, after --")
    args = ap.parse_args()

    binary = os.path.expanduser(args.binary)
    cmd = [binary, "-m", os.path.expanduser(args.model_file), "-p", str(args.prompt_tokens),
           "-n", str(args.gen_tokens), "-r", str(args.repetitions), "-o", "json", *args.extra]
    print("Recording conditions (hashing the model file can take a few seconds)...")
    before = conditions.snapshot((), os.path.expanduser(args.model_file))
    problems = conditions.problems(before)
    if args.repetitions < 5:
        problems.append(f"only {args.repetitions} repetitions (at least 5)")
    if problems and not args.exploratory:
        print("Not starting: this run could not count as valid.")
        for p in problems:
            print("  -", p)
        raise SystemExit(2)

    print("$", shlex.join(cmd))
    cpu_start, t_start = conditions.cpu_times(), time.monotonic()
    r = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.monotonic() - t_start
    # llama-bench has exited, so its CPU time is gone from the end reading.
    during = conditions.cpu_during(cpu_start, conditions.cpu_times(), elapsed, conditions.own_tree())
    after = conditions.snapshot(())
    for p in conditions.problems(after, require_model_file=False, check_busy=False) + conditions.busy_problems(during):
        if p not in problems:
            problems.append("after the run: " + p)
    if r.returncode != 0:
        problems.append(f"llama-bench exited with {r.returncode}")
    try:
        rows = json.loads(r.stdout)
    except json.JSONDecodeError:
        rows = None
        problems.append("llama-bench printed no JSON")

    out = conditions.run_dir(args.name, valid=not problems)
    with open(os.path.join(out, "raw.json"), "w") as f:
        f.write(r.stdout)
    with open(os.path.join(out, "stderr.log"), "w") as f:
        f.write(r.stderr)
    summary = [
        {"test": f"pp{row['n_prompt']}" if row.get("n_prompt") else f"tg{row['n_gen']}",
         "avg_tok_s": row.get("avg_ts"), "stddev_tok_s": row.get("stddev_ts"),
         "samples_tok_s": row.get("samples_ts"), "n_gpu_layers": row.get("n_gpu_layers"),
         "flash_attn": row.get("flash_attn"), "build": row.get("build_commit"), "build_number": row.get("build_number")}
        for row in rows or []
    ]
    conditions.write_manifest(out, {
        "name": args.name, "valid": not problems, "problems": problems, "notes": args.notes,
        "settings": {"command": cmd, "version": conditions.sh([binary, "--version"])[:500]},
        "summary": summary, "conditions_before": before, "conditions_after": after,
        "cpu_during_run": {"seconds": round(elapsed, 1), "busiest_other_processes": during},
    })
    for s in summary:
        print(f"  {s['test']}: {s['avg_tok_s']:.1f} ± {s['stddev_tok_s']:.1f} tok/s")
    print("VALID" if not problems else "NOT VALID, filed as exploratory:")
    for p in problems:
        print("  -", p)
    print(f"saved in {out}")


if __name__ == "__main__":
    main()
