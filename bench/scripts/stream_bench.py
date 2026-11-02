#!/usr/bin/env python3
"""Measure TTFT, prefill and decode speed of an OpenAI-compatible server, streaming.

Standard library only: runs on any python3 with nothing to install.

Example:
    python3 bench/scripts/stream_bench.py --name nekko-qwen3-8b \
        --target nekko=http://127.0.0.1:11500/v1 \
        --model chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M \
        --model-file ~/.nekko-agent/models/chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf

With several targets, requests alternate between them (A, B, A, B, ...) so a
machine that slowly heats up slows every target equally instead of whichever
ran last.

Each run gets its own folder: raw.jsonl (every request, with every token's
arrival time) and manifest.json (the machine's conditions before and after,
the exact settings, the checks and the medians). The script refuses to start
when a check fails (on battery, another model loaded, uncommitted scripts...);
--exploratory runs anyway and files the run under exploratory/ with the reasons.
"""

import argparse
import hashlib
import json
import os
import statistics
import time
import urllib.request
import sys
import urllib.parse
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conditions  # noqa: E402

# A fixed prompt of ~500 tokens with no repeated passages. Repetition matters:
# n-gram speculative decoding (llama-server's --spec-default) copies tokens it
# has already seen in the context, so a repetitive prompt would inflate decode
# speed for servers that use it and make the comparison unfair.
PROMPT = """You are writing for a general audience. Read the background notes below, then answer the task at the end.

Background notes:
- The four-stroke cycle was patented by Nikolaus Otto in 1876, building on earlier work by Alphonse Beau de Rochas, who described the principle in 1862 but never built a working engine.
- In the intake stroke the piston moves down while the intake valve is open, drawing in a mixture of air and fuel; in a direct-injection engine only air enters at this stage.
- During compression both valves are closed and the piston rises, raising the pressure of the charge to roughly ten to fourteen times atmospheric pressure in a typical petrol engine.
- Near the top of the stroke a spark plug ignites the mixture. Combustion temperatures can briefly exceed 2,000 degrees Celsius, and the expanding gas pushes the piston down in the power stroke.
- In the exhaust stroke the exhaust valve opens and the rising piston expels the burned gases, after which the cycle repeats.
- Rudolf Diesel's engine, first demonstrated in 1897, has no spark plug: air alone is compressed so strongly, often above twenty to one, that injected fuel ignites from the heat of compression.
- Diesel engines usually reach higher thermal efficiency, while petrol engines tend to rev higher and weigh less for the same power.
- Common sources of inefficiency include heat lost through cylinder walls, friction in bearings and piston rings, pumping losses at part throttle, and incomplete combustion.
- Famous examples include the Ford Model T's 2.9-litre four-cylinder, the air-cooled flat-four of the Volkswagen Beetle, and the Rolls-Royce Merlin V12 that powered the Spitfire.

Task: Write a clear, well-structured explanation of how a four-stroke engine works. Walk through each stroke in order and describe what the valves, piston and crankshaft are doing. Then compare the Otto and Diesel cycles, explain the main causes of lost efficiency, and finish with a short paragraph on each of the three historical engines. Use headings and keep the tone friendly but precise."""


# A code edit, the case n-gram speculative decoding is built for: the reply
# copies almost all of its input. Thinking is switched off with Qwen3's own
# /no_think switch, part of its chat template, so every server gets it alike.
CODE_EDIT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "code_edit_source.py")
with open(CODE_EDIT_FILE) as _f:
    CODE_EDIT_SOURCE = _f.read()
CODE_EDIT_PROMPT = (
    "/no_think\n"
    "Rename the function `apply_discount` to `discounts_for` everywhere in this file, including where it is"
    " called. Change nothing else. Reply with the complete updated file in one ```python code block and"
    " nothing else.\n\n```python\n" + CODE_EDIT_SOURCE + "```"
)
# What a correct reply contains: the file with only that rename.
CODE_EDIT_EXPECTED = CODE_EDIT_SOURCE.replace("apply_discount", "discounts_for")

# A short question with almost nothing in the prompt for n-gram speculative
# decoding to copy: the unfavourable case for it, next to PROMPT, whose
# background notes the model's thinking tends to restate.
SHORT_PROMPT = (
    "Invent a board game for four players that takes about thirty minutes. Describe the pieces,"
    " the goal, one turn and how the game ends."
)

WORKLOADS = {
    # name: (prompt, default max_tokens)
    "chat": (PROMPT, 512),
    "chat-short": (SHORT_PROMPT, 512),
    "code-edit": (CODE_EDIT_PROMPT, 4096),
}


def code_block(text):
    """The first ```python block of a reply, or None."""
    start = text.find("```python")
    if start < 0:
        return None
    start = text.find("\n", start) + 1
    end = text.find("```", start)
    return text[start:end] if end >= 0 else None


def one_request(url, model, max_tokens, api_key, timeout, prompt=PROMPT):
    # A different id at the START of the prompt on every request: servers reuse
    # the prefill of a prompt they have already seen (prompt cache), and without
    # it TTFT from the second request on would be fake, close to zero.
    nonce = uuid.uuid4().hex[:8]
    body = {
        "model": model,
        "messages": [{"role": "user", "content": f"[request {nonce}]\n{prompt}"}],
        "stream": True,
        # Ask the server for the official token counts in the last chunk.
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
        "temperature": 0,
        "seed": 42,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(), headers=headers)

    chunk_times = []       # arrival time of every chunk that carries text
    usage = None           # official token counts, when the server sends them
    server_timings = None  # llama-server's own timings, to compare with ours
    pieces = []
    finish_reason = None

    t_send = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as res:
        # Streaming (SSE) arrives as "data: {...}" lines, one per chunk.
        for raw in res:
            now = time.perf_counter()
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            msg = json.loads(payload)
            usage = msg.get("usage") or usage
            server_timings = msg.get("timings") or server_timings
            for choice in msg.get("choices") or []:
                finish_reason = choice.get("finish_reason") or finish_reason
                delta = choice.get("delta") or {}
                # Qwen3 thinks before answering and those tokens arrive in
                # reasoning_content (llama-server) or reasoning (Ollama). They are
                # generated tokens, so they count.
                piece = "".join(delta.get(k) or "" for k in ("content", "reasoning_content", "reasoning"))
                if piece:
                    chunk_times.append(now)
                    pieces.append(piece)
    t_end = time.perf_counter()

    if not chunk_times:
        raise RuntimeError("no tokens received")

    prompt_tokens = (usage or {}).get("prompt_tokens")
    completion_tokens = (usage or {}).get("completion_tokens")
    # Without usage, fall back on the chunk count (usually one chunk per token).
    n_tokens = completion_tokens or len(chunk_times)

    ttft = chunk_times[0] - t_send
    decode_window = chunk_times[-1] - chunk_times[0]
    return {
        "nonce": nonce,
        "ttft_s": ttft,
        # The first token is left out: its time is already in TTFT (prefill).
        "decode_tok_s": (n_tokens - 1) / decode_window if decode_window > 0 else None,
        "prefill_tok_s_est": prompt_tokens / ttft if prompt_tokens else None,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "chunks": len(chunk_times),
        "text_chars": sum(len(p) for p in pieces),
        "finish_reason": finish_reason,
        # The whole reply, so replies can be compared across servers.
        "text": "".join(pieces),
        "total_s": t_end - t_send,
        # Raw arrival times relative to sending, for anyone who wants to redo the math.
        "chunk_offsets_s": [round(t - t_send, 6) for t in chunk_times],
        "server_timings": server_timings,
    }


def replies(results, workload):
    """How alike the replies were, per server: identical texts, and for a code edit, correct edits."""
    out = {}
    every = [r["text"] for rows in results.values() for r in rows]
    common = max(set(every), key=every.count) if every else None
    for label, rows in results.items():
        entry = {
            "completion_tokens": sorted({r["completion_tokens"] for r in rows}),
            "same_as_most_common_reply": sum(r["text"] == common for r in rows),
            "of": len(rows),
        }
        if workload == "code-edit":
            entry["correct_edit"] = sum(code_block(r["text"]) == CODE_EDIT_EXPECTED for r in rows)
        out[label] = entry
    return out


def full_budget(r, max_tokens):
    """Whether a chat reply used the whole token budget."""
    return r["completion_tokens"] == max_tokens or (
        r.get("finish_reason") == "length" and r["completion_tokens"] >= max_tokens - 1)


def drafts(rows):
    """Speculative decoding totals: (drafted, accepted) over these requests."""
    t = [r["server_timings"] or {} for r in rows]
    return sum(x.get("draft_n", 0) for x in t), sum(x.get("draft_n_accepted", 0) for x in t)


def summary(rows):
    def stats(key, scale=1):
        vals = [r[key] * scale for r in rows if r[key] is not None]
        if not vals:
            return None
        return {"median": statistics.median(vals), "min": min(vals), "max": max(vals), "n": len(vals)}

    def server(key):
        vals = [r["server_timings"][key] for r in rows if (r["server_timings"] or {}).get(key) is not None]
        return statistics.median(vals) if vals else None

    return {
        "ttft_ms": stats("ttft_s", 1000),
        "decode_tok_s": stats("decode_tok_s"),
        "prefill_tok_s_est": stats("prefill_tok_s_est"),
        "server_decode_tok_s_median": server("predicted_per_second"),
        "server_prefill_tok_s_median": server("prompt_per_second"),
        "decode_drift_pct": drift(rows),
        # Every generated token over all the time spent generating: what a user sees
        # across many replies. For a speculative decoding server on chat, whose speed
        # follows each reply, this is the figure to quote, not the median.
        "decode_all_tokens_tok_s": all_tokens_rate(rows),
        "drafts": draft_stats(rows),
    }


def all_tokens_rate(rows):
    timed = [r for r in rows if r["decode_tok_s"]]
    if not timed:
        return None
    return sum(r["completion_tokens"] - 1 for r in timed) / sum((r["completion_tokens"] - 1) / r["decode_tok_s"] for r in timed)


def draft_stats(rows):
    """Per-request draft tokens accepted, for a speculative decoding server; None otherwise."""
    if not drafts(rows)[0]:
        return None
    kept = [(r["server_timings"] or {}).get("draft_n_accepted", 0) for r in rows]
    drafted, accepted = drafts(rows)
    return {"accepted_per_request": {"median": statistics.median(kept), "min": min(kept), "max": max(kept)},
            "acceptance_rate": round(accepted / drafted, 3)}


def drift(rows):
    """How much decode moved from the first measured requests to the last, in %.

    Near zero means the conditions held still. A steady fall is the chip
    heating up: the median then depends on how long the run lasted.
    """
    vals = [r["decode_tok_s"] for r in rows if r["decode_tok_s"]]
    if len(vals) < 6:
        return None
    first, last = statistics.median(vals[:3]), statistics.median(vals[-3:])
    return round(100 * (last - first) / first, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="short name for the run folder, e.g. llama-server-default-qwen3-8b")
    ap.add_argument("--target", action="append", required=True, metavar="LABEL=URL",
                    help="a configuration to measure and its OpenAI base URL, e.g."
                         " llama-server=http://127.0.0.1:8080/v1; repeat to alternate between several")
    ap.add_argument("--model", required=True, help="the model name the servers expect in requests")
    ap.add_argument("--target-model", action="append", default=[], metavar="LABEL=NAME",
                    help="a different model name for one target, e.g. nekko=chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M")
    ap.add_argument("--model-file", help="the weights the servers loaded (a file, or an MLX model folder), hashed"
                                         " into the manifest")
    ap.add_argument("--target-model-file", action="append", default=[], metavar="LABEL=PATH",
                    help="different weights for one target, e.g. mlx-lm=~/.lmstudio/models/Qwen/Qwen3-8B-MLX-4bit")
    ap.add_argument("--notes", default="", help="anything a reader needs: how the server was started, versions not detected")
    ap.add_argument("--runs", type=int, default=5, help="measured requests per target")
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--scenario", required=True, choices=["burst", "sustained"],
                    help="burst: a cool chip, with --pause between requests (chats with gaps);"
                         " sustained: a hot chip, after --preheat seconds of work (an agent working nonstop)")
    ap.add_argument("--pause", type=float, default=0, help="seconds to wait before every measured request")
    ap.add_argument("--preheat", type=float, default=0, help="seconds of unmeasured requests before measuring")
    ap.add_argument("--max-drift", type=float, default=3.0,
                    help="largest decode drift, in %%, from the first requests to the last for the run to count")
    ap.add_argument("--workload", choices=sorted(WORKLOADS), default="chat",
                    help="chat: a ~455-token prompt with background notes, 512 tokens generated; chat-short: a"
                         " one-sentence question, little to copy, 512 tokens generated; code-edit: rename a function"
                         " in a ~150-line file and reply with the whole file, generation ends on its own")
    ap.add_argument("--max-tokens", type=int, help="default 512 for chat, 4096 for code-edit")
    ap.add_argument("--speculative", action="store_true",
                    help="speculative decoding is what this run measures, so draft tokens are expected")
    ap.add_argument("--exploratory", action="store_true", help="run even if checks fail; file it under exploratory/")
    ap.add_argument("--api-key")
    ap.add_argument("--timeout", type=float, default=600)
    args = ap.parse_args()
    prompt, default_max = WORKLOADS[args.workload]
    if args.max_tokens is None:
        args.max_tokens = default_max

    targets = [t.split("=", 1) for t in args.target]
    models = {label: args.model for label, _ in targets}
    for t in args.target_model:
        label, name = t.split("=", 1)
        if label not in models:
            raise SystemExit(f"--target-model {label}: no --target has that label")
        models[label] = name
    ports = sorted({urllib.parse.urlparse(url).port for _, url in targets})
    print("Recording conditions (hashing the model file can take a few seconds)...")
    before = conditions.snapshot(ports, args.model_file)
    # Which weights each target ran, when they differ (GGUF against MLX).
    weights = {label: before.get("model_file") for label, _ in targets}
    for t in args.target_model_file:
        label, path = t.split("=", 1)
        if label not in weights:
            raise SystemExit(f"--target-model-file {label}: no --target has that label")
        weights[label] = conditions.model_identity(path)
    before["target_model_files"] = weights
    problems = conditions.problems(before, require_model_file=True)
    if args.runs < 5:
        problems.append(f"only {args.runs} measured requests per target (at least 5)")
    if args.warmup < 1:
        problems.append("no warmup request")
    if args.scenario == "burst" and args.pause <= 0:
        problems.append("a burst run needs --pause, or the chip heats up between requests")
    if args.scenario == "sustained" and args.preheat <= 0:
        problems.append("a sustained run needs --preheat, or it measures a chip still heating up")
    if problems and not args.exploratory:
        print("Not starting: this run could not count as valid.")
        for p in problems:
            print("  -", p)
        print("Fix these, or pass --exploratory to run anyway and file it as exploratory.")
        raise SystemExit(2)

    out = conditions.run_dir(args.name, valid=not problems)
    raw_path = os.path.join(out, "raw.jsonl")
    width = max(len(label) for label, _ in targets)
    results = {label: [] for label, _ in targets}
    cpu_start, t_start = conditions.cpu_times(), time.monotonic()
    try:
        measure(args, targets, models, prompt, raw_path, results, width, t_start)
    except Exception as e:
        # Keep what happened, but never as a valid run.
        problems.append(f"the run stopped early: {type(e).__name__}: {e}")
        if os.path.basename(os.path.dirname(out)) == "runs":
            moved = os.path.join(conditions.ROOT, "exploratory", os.path.basename(out))
            os.rename(out, moved)
            out = moved
        conditions.write_manifest(out, {
            "name": args.name, "valid": False, "problems": problems, "notes": args.notes,
            "settings": {"targets": dict(targets), "target_models": models, "workload": args.workload},
            "conditions_before": before, "conditions_after": conditions.snapshot(ports),
        })
        print("STOPPED:", problems[-1])
        print(f"what was recorded is in {out}")
        raise SystemExit(1)
    finish(args, targets, models, prompt, problems, out, results, width, before, ports, cpu_start, t_start)


def measure(args, targets, models, prompt, raw_path, results, width, t_start):
    if args.preheat > 0:
        print(f"Preheating for {args.preheat:.0f} s with unmeasured requests...")
        n = 0
        while time.monotonic() - t_start < args.preheat:
            for label, url in targets:
                r = one_request(url, models[label], args.max_tokens, args.api_key, args.timeout, prompt)
                r.update(label=label, url=url, model=models[label], warmup=True, preheat=True, run=-1, ts=time.time())
                with open(raw_path, "a") as f:
                    f.write(json.dumps(r) + "\n")
                n += 1
                print(f"  preheat {n:3}: {label} decode {r['decode_tok_s'] or 0:5.1f} tok/s"
                      f" ({time.monotonic() - t_start:4.0f} s)")
    for i in range(args.warmup + args.runs):
        warm = i < args.warmup
        for label, url in targets:
            if not warm and args.pause > 0:
                time.sleep(args.pause)
            r = one_request(url, models[label], args.max_tokens, args.api_key, args.timeout, prompt)
            r.update(label=label, url=url, model=models[label], warmup=warm,
                     run=i - args.warmup, ts=time.time())
            with open(raw_path, "a") as f:
                f.write(json.dumps(r) + "\n")
            tag = "warmup" if warm else f"run {r['run'] + 1}/{args.runs}"
            st = r["server_timings"] or {}
            # draft_n / draft_n_accepted: speculative decoding at work (tokens guessed / kept).
            spec = f", drafts {st['draft_n_accepted']}/{st['draft_n']} kept" if "draft_n" in st else ""
            print(f"{label:>{width}} {tag:>9}: TTFT {r['ttft_s'] * 1000:6.0f} ms | decode {r['decode_tok_s'] or 0:6.1f} tok/s"
                  f" | prompt {r['prompt_tokens']} tok, reply {r['completion_tokens']} tok in {r['chunks']} chunks"
                  + (f" | server says: decode {st.get('predicted_per_second', 0):.1f},"
                     f" prefill {st.get('prompt_per_second', 0):.0f} tok/s{spec}" if st else ""))
            if not warm:
                results[label].append(r)


def finish(args, targets, models, prompt, problems, out, results, width, before, ports, cpu_start, t_start):
    elapsed = time.monotonic() - t_start
    after = conditions.snapshot(ports)
    servers = {p["pid"] for t in after["targets"] for p in t.get("processes", [])}
    during = conditions.cpu_during(cpu_start, conditions.cpu_times(), elapsed, conditions.own_tree() | servers)
    # Checks on what happened during the run, not only before it.
    for p in conditions.problems(after, require_model_file=False, check_busy=False) + conditions.busy_problems(during):
        if p not in problems:
            problems.append("after the run: " + p)
    chat_like = args.workload in ("chat", "chat-short")
    # On chat, a speculative decoding server's speed follows what each reply
    # happens to repeat (101 to 617 tok/s across eight requests that differed
    # only in their id), so its drift says nothing about the machine. The
    # servers without drafts are the thermometer; that server is reported as a
    # distribution over more requests instead.
    varying = {label for label, rows in results.items() if chat_like and drafts(rows)[0]}
    thermometers = [label for label in results if label not in varying]
    if varying and not thermometers:
        problems.append("every server drafted, so no server shows whether the machine held still")
    for label in varying:
        if args.runs < 16:
            problems.append(f"{label}: speculative decoding on chat varies request by request; measure at least"
                            f" 16 requests, not {args.runs}")
    for label, rows in results.items():
        drafted = drafts(rows)[0]
        if drafted and not args.speculative:
            problems.append(f"{label}: speculative decoding was on ({drafted} draft tokens) but this run is not about it")
        moved_pct = drift(rows)
        if label not in varying and moved_pct is not None and abs(moved_pct) > args.max_drift:
            # One server moving while the others held still has two known causes: the
            # server's own state (Nekko with speculative decoding is faster for its first
            # requests after loading), or that server feeling heat the others do not
            # (llama-server oscillated under sustained load while mlx-lm held flat).
            # The script cannot tell which; the raw arrival times and powermetrics can.
            steady = [other for other, r in results.items()
                      if other != label and other not in varying and abs(drift(r) or 0) <= args.max_drift]
            hint = (f"only this server moved ({', '.join(steady)} held still): either its own state (try more"
                    " --warmup) or it slows with heat when the others do not (check GPU clock with powermetrics)"
                    if steady else "pause longer" if args.scenario == "burst" else "preheat longer")
            problems.append(f"{label}: decode drifted {moved_pct:+.1f}% from the first requests to the last"
                            f" (limit {args.max_drift}%): {hint}")
        if chat_like:
            # LM Studio's MLX engine stops at the budget (finish_reason "length") but
            # reports one token fewer, 511 of 512; the stream carries as much text.
            short = [r["completion_tokens"] for r in rows if not full_budget(r, args.max_tokens)]
            if short:
                problems.append(f"{label}: some replies stopped before {args.max_tokens} tokens ({short}), so runs differ in length")
        else:
            cut = [r["completion_tokens"] for r in rows if r["finish_reason"] != "stop"]
            if cut:
                problems.append(f"{label}: some replies did not finish on their own ({cut} tokens)")
    if args.workload == "code-edit":
        # Speed depends on what is generated, so every server must generate the same amount.
        lengths = {label: statistics.median(r["completion_tokens"] for r in rows) for label, rows in results.items()}
        if max(lengths.values()) > 1.02 * min(lengths.values()):
            problems.append(f"replies differ in length between servers by more than 2% ({lengths})")

    if problems and os.path.basename(os.path.dirname(out)) == "runs":
        moved = os.path.join(conditions.ROOT, "exploratory", os.path.basename(out))
        os.rename(out, moved)
        out = moved

    with open(__file__, "rb") as f:
        script_sha = hashlib.sha256(f.read()).hexdigest()
    conditions.write_manifest(out, {
        "name": args.name,
        "valid": not problems,
        "problems": problems,
        "notes": args.notes,
        "settings": {
            "targets": dict(targets), "model": args.model, "target_models": models,
            "target_weights_sha256": {label: (w or {}).get("sha256") for label, w in before["target_model_files"].items()},
            "runs": args.runs, "warmup": args.warmup,
            "max_tokens": args.max_tokens, "temperature": 0, "seed": 42, "stream": True,
            "speculative_expected": args.speculative,
            "scenario": args.scenario, "pause_s": args.pause, "preheat_s": args.preheat,
            "max_drift_pct": args.max_drift,
            "workload": args.workload,
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "script_sha256": script_sha,
        },
        "summary": {label: summary(rows) for label, rows in results.items()},
        "replies": replies(results, args.workload),
        "conditions_before": before,
        "conditions_after": after,
        "cpu_during_run": {"seconds": round(elapsed, 1), "busiest_other_processes": during},
    })

    print(f"\nmedians over {args.runs} requests each:")
    for label, rows in results.items():
        s = summary(rows)
        print(f"  {label:>{width}}: TTFT {s['ttft_ms']['median']:.0f} ms,"
              f" decode {s['decode_tok_s']['median']:.1f} tok/s (min {s['decode_tok_s']['min']:.1f}, max {s['decode_tok_s']['max']:.1f}),"
              f" server prefill {s['server_prefill_tok_s_median'] or float('nan'):.0f} tok/s,"
              f" drift {s['decode_drift_pct']}%")
    for label, entry in replies(results, args.workload).items():
        print(f"  {label:>{width}}: reply tokens {entry['completion_tokens']},"
              f" {entry['same_as_most_common_reply']}/{entry['of']} identical to the most common reply"
              + (f", {entry['correct_edit']}/{entry['of']} correct edits" if "correct_edit" in entry else ""))
    print("VALID" if not problems else "NOT VALID, filed as exploratory:")
    for p in problems:
        print("  -", p)
    print(f"saved in {out}")


if __name__ == "__main__":
    main()
