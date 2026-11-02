#!/usr/bin/env python3
"""Rewrite the results section of REPORT.md from the run manifests.

Every number in that section comes from runs/*/manifest.json and raw data,
never typed by hand. Each run is checked again against the current rules, using
the conditions its manifest recorded at run time, so a run that was valid under
older, looser rules is listed apart with the reason instead of in the tables.

    python3 bench/scripts/report.py           # rewrite the section
    python3 bench/scripts/report.py --check   # exit 1 if REPORT.md is out of date
"""

import argparse
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conditions  # noqa: E402
from stream_bench import drafts, drift, full_budget  # noqa: E402

ROOT = conditions.ROOT
START, END = "<!-- results:start -->", "<!-- results:end -->"
MAX_DRIFT = 3.0


def load(run):
    with open(os.path.join(run, "manifest.json")) as f:
        m = json.load(f)
    raw = os.path.join(run, "raw.jsonl")
    rows = [json.loads(line) for line in open(raw)] if os.path.exists(raw) else None
    return m, rows


def recheck(m, rows):
    """Why this run fails the current rules, or []."""
    out = conditions.problems(m["conditions_before"], require_model_file=True)
    out += conditions.problems(m["conditions_after"], require_model_file=False, check_busy=False)
    during = m.get("cpu_during_run")
    if during is None:
        out.append("no record of other processes' CPU during the run")
    else:
        out += conditions.busy_problems(during["busiest_other_processes"])
    if rows is None:  # llama-bench
        return sorted(set(out))
    s = m["settings"]
    scenario = s.get("scenario")
    if scenario not in ("burst", "sustained"):
        out.append("no scenario: neither paused between requests nor preheated")
    elif scenario == "burst" and not s.get("pause_s"):
        out.append("burst without a pause")
    elif scenario == "sustained" and not s.get("preheat_s"):
        out.append("sustained without preheat")
    measured = [r for r in rows if not r.get("warmup")]
    labels = sorted({r["label"] for r in measured})
    chat_like = s.get("workload", "chat") in ("chat", "chat-short")
    # A speculative decoding server on chat varies with each reply's content; the
    # servers without drafts show whether the machine held still (see stream_bench).
    varying = {label for label in labels if chat_like and drafts([r for r in measured if r["label"] == label])[0]}
    if varying and len(varying) == len(labels):
        out.append("every server drafted, so no server shows whether the machine held still")
    for label in labels:
        mine = [r for r in measured if r["label"] == label]
        if len(mine) < 5:
            out.append(f"{label}: fewer than 5 measured requests")
        if label in varying and len(mine) < 16:
            out.append(f"{label}: speculative decoding on chat needs at least 16 measured requests")
        d = drift(mine)
        if label not in varying and d is not None and abs(d) > MAX_DRIFT:
            out.append(f"{label}: decode drifted {d:+.1f}%")
        if chat_like:
            if any(not full_budget(r, s["max_tokens"]) for r in mine):
                out.append(f"{label}: a reply stopped short of {s['max_tokens']} tokens")
        elif any(r.get("finish_reason") != "stop" for r in mine):
            out.append(f"{label}: a reply did not finish on its own")
        if not s.get("speculative_expected") and any((r["server_timings"] or {}).get("draft_n") for r in mine):
            out.append(f"{label}: speculative decoding drafts")
    if s.get("workload") == "code-edit":
        lengths = [statistics.median(r["completion_tokens"] for r in measured if r["label"] == label)
                   for label in s["targets"]]
        if max(lengths) > 1.02 * min(lengths):
            out.append("replies differ in length between servers by more than 2%")
    return sorted(set(out))


def stats(vals):
    return statistics.median(vals), min(vals), max(vals)


def server_table(name, m, rows):
    measured = [r for r in rows if not r.get("warmup")]
    lines = ["| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median"
             " | Whole reply, s, median | Decode drift |",
             "| --- | --- | --- | --- | --- | --- |"]
    labels = list(m["settings"]["targets"])
    for label in labels:
        mine = [r for r in measured if r["label"] == label]
        dec = stats([r["decode_tok_s"] for r in mine])
        ttft = statistics.median(r["ttft_s"] * 1000 for r in mine)
        pre = [r["server_timings"]["prompt_per_second"] for r in mine if r.get("server_timings")]
        pre_s = f"{statistics.median(pre):.0f}" if pre else "n/a"
        total = statistics.median(r["total_s"] for r in mine)
        lines.append(f"| {label} | {dec[0]:.1f} ({dec[1]:.1f}–{dec[2]:.1f}) | {ttft:.0f} | {pre_s} | {total:.2f}"
                     f" | {drift(mine):+.1f}% |")
    # Each other server against the shared reference, plain llama-server.
    ref = next((label for label in labels if label.startswith("llama-server")), None)
    if ref:
        med = lambda label, key: statistics.median(r[key] for r in measured if r["label"] == label)
        lines.append("")
        for label in labels:
            if label == ref:
                continue
            ratio = med(label, "decode_tok_s") / med(ref, "decode_tok_s")
            change = f"{100 * (ratio - 1):+.1f}%" if ratio < 1.5 else f"{ratio:.1f}x"
            lines.append(f"- {label} against {ref}: decode {change},"
                         f" whole reply {med(ref, 'total_s') / med(label, 'total_s'):.2f}x as fast.")
    spec = [label for label in labels
            if any((r["server_timings"] or {}).get("draft_n") for r in measured if r["label"] == label)]
    chat_like = m["settings"].get("workload", "chat") in ("chat", "chat-short")
    if spec:
        lines.append("")
        for label in spec:
            mine = [r for r in measured if r["label"] == label]
            kept = [(r["server_timings"] or {}).get("draft_n_accepted", 0) for r in mine]
            drafted = sum((r["server_timings"] or {}).get("draft_n", 0) for r in mine)
            lines.append(f"- {label} speculative decoding: {statistics.median(kept):.0f} draft tokens accepted per reply"
                         f" (median; {min(kept)}–{max(kept)}), {100 * sum(kept) / drafted:.0f}% of those drafted.")
            if chat_like:
                # Its speed follows each reply, and a reply that recurs can carry the
                # median; all tokens over all generation time is the figure to quote.
                rate = (sum(r["completion_tokens"] - 1 for r in mine)
                        / sum((r["completion_tokens"] - 1) / r["decode_tok_s"] for r in mine))
                texts = [r["text"] for r in mine]
                ref_rate = None
                if ref:
                    rr = [r for r in measured if r["label"] == ref]
                    ref_rate = (sum(r["completion_tokens"] - 1 for r in rr)
                                / sum((r["completion_tokens"] - 1) / r["decode_tok_s"] for r in rr))
                lines.append(f"- {label} on chat: {rate:.1f} tok/s over all its tokens and generation time"
                             + (f" ({rate / ref_rate:.1f}x {ref})" if ref_rate else "")
                             + f"; its speed follows each reply, and {max(texts.count(t) for t in set(texts))}"
                             f" of its {len(texts)} replies were the same text, so the median is not the figure"
                             " to quote.")
    replies = m.get("replies")
    if replies and all("text" in r for r in measured):
        # Per server: how many different replies it gave. A count against the most
        # common reply across servers mixes servers running different weights.
        lines.append("")
        for label in labels:
            texts = [r["text"] for r in measured if r["label"] == label]
            e = replies.get(label, {})
            lines.append(f"- {label} replies: {e.get('completion_tokens')} tokens, {len(set(texts))} different"
                         f" text{'s' if len(set(texts)) != 1 else ''} in {len(texts)} replies"
                         + (f", {e['correct_edit']}/{e['of']} correct edits" if "correct_edit" in e else "") + ".")
    return lines


def weights_line(mf):
    return (f"`{os.path.basename(mf['path'])}`, {mf['bytes'] / 1e9:.2f} GB, sha256 `{mf['sha256'][:16]}…`"
            + (" (over every file in the folder)" if "files" in mf else ""))


def weights_lines(m):
    """The weights each server ran: one line if they all ran the same file."""
    b = m["conditions_before"]
    per = b.get("target_model_files") or {}
    distinct = {(w or {}).get("sha256") for w in per.values()}
    if len(distinct) <= 1:
        return [f"Weights: {weights_line(b['model_file'])}.", ""]
    return ["Weights:", ""] + [f"- {label}: {weights_line(w)}" for label, w in per.items()] + [""]


def bench_table(m):
    lines = ["| Test | tok/s, mean ± stddev | Samples |", "| --- | --- | --- |"]
    for s in m["summary"]:
        samples = ", ".join(f"{x:.1f}" for x in s["samples_tok_s"])
        lines.append(f"| {s['test']} | {s['avg_tok_s']:.1f} ± {s['stddev_tok_s']:.1f} | {samples} |")
    return lines


def describe(m):
    s = m["settings"]
    if "scenario" in s and s.get("scenario"):
        how = (f"burst, {s['pause_s']:.0f} s pause before every request" if s["scenario"] == "burst"
               else f"sustained, measured after {s['preheat_s']:.0f} s of nonstop requests")
        what = {
            "code-edit": "code edit: rename a function in a 156-line file and reply with the whole file",
            "chat-short": f"short chat: a one-sentence question, {s['max_tokens']} tokens generated",
        }.get(s.get("workload"), f"chat: ~455-token prompt with background notes, {s['max_tokens']} tokens generated")
        return (f"{what}; {how}; {s.get('warmup', 1)} warmup and {s['runs']} measured requests per server,"
                " alternating")
    if "command" in s:
        return "`" + " ".join(os.path.basename(a) if a.startswith("/") else a for a in s["command"]) + "`"
    return "no scenario"


def section():
    runs = sorted(glob.glob(os.path.join(ROOT, "runs", "*")))
    ok, excluded = [], []
    for run in runs:
        m, rows = load(run)
        why = recheck(m, rows)
        (excluded if why else ok).append((run, m, rows, why))

    first = ok[0][1] if ok else None
    out = [START, "",
           "_Generated by `bench/scripts/report.py` from the run manifests. Do not edit by hand._", ""]
    if first:
        mach = first["conditions_before"]["machine"]
        out += [f"Machine: {mach['chip']} ({mach['model']}), {mach['memory_bytes'] // 2**30} GB,"
                f" macOS {mach['macos']} ({mach['macos_build']}).", ""]
    for run, m, rows, _ in ok:
        name = os.path.basename(run)
        out += [f"### {m['name']}", "", f"Run `runs/{name}`: {describe(m)}.", ""]
        out += weights_lines(m)
        out += bench_table(m) if rows is None else server_table(name, m, rows)
        if m.get("notes"):
            out += ["", f"Notes recorded with the run: {m['notes']}"]
        out.append("")
    if excluded:
        out += ["### Runs not used", "",
                "Saved under `runs/` because they passed the checks in force when they ran, but they fail the current"
                " rules, so no number above comes from them.", ""]
        for run, m, rows, why in excluded:
            out.append(f"- `runs/{os.path.basename(run)}`: " + "; ".join(why) + ".")
        out.append("")
    out.append(END)
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    path = os.path.join(ROOT, "REPORT.md")
    text = open(path).read()
    if START not in text or END not in text:
        raise SystemExit(f"REPORT.md needs {START} and {END} markers")
    new = text[:text.index(START)] + section() + text[text.index(END) + len(END):]
    if args.check:
        raise SystemExit(0 if new == text else 1)
    with open(path, "w") as f:
        f.write(new)
    print("REPORT.md results section rewritten")


if __name__ == "__main__":
    main()
