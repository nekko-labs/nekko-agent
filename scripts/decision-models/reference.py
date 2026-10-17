"""Record what the official `laya` package answers for the golden cases.

Writes the file `crates/nekko-decide/tests/golden.rs` compares against: per case, the
package's response, a fingerprint of every question's token sequence (length, marker
positions, FNV-1a 64 over the ids as little-endian u32) and every option's probability at
full precision. Runs on the CPU in fp32, so it is the reference the ONNX exports are held to.

    python reference.py --checkpoint laya-en --out ../../crates/nekko-decide/tests/golden/golden.json

Build-time only; see README.md.
"""
import argparse
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from checkpoints import CHECKPOINTS, load_agent  # noqa: E402

import laya  # noqa: E402
import laya.agent as agent_mod  # noqa: E402


def fnv64(ids):
    h = 0xCBF29CE484222325
    for t in ids:
        for b in int(t & 0xFFFFFFFF).to_bytes(4, "little"):
            h ^= b
            h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % h


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", choices=sorted(CHECKPOINTS), default="laya-en")
    ap.add_argument("--cases", default=os.path.join(os.path.dirname(__file__), "..", "..", "crates", "nekko-decide",
                                                    "tests", "golden", "cases.json"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    torch.manual_seed(0)
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    agent = load_agent(args.checkpoint)

    # Every question's probability row as `_decode_answers` computes it (after the temperature
    # and `option_order` un-permutation), before the response rounds it to 4 places.
    rows = []
    real_unpermute = agent_mod.unpermute_probs

    def capture(p, order):
        out = real_unpermute(p, order)
        rows.append([float(v) for v in np.asarray(out, dtype=np.float64)])
        return out

    agent_mod.unpermute_probs = capture

    # Every question's token sequence and marker positions.
    encoded = []
    real_encode = agent._encode_state

    def encode(*a, **kw):
        items = real_encode(*a, **kw)
        encoded.append(items)
        return items

    agent._encode_state = encode

    cases = json.load(open(args.cases, encoding="utf-8"))["cases"]
    golden = []
    for case in cases:
        rows.clear()
        encoded.clear()
        res = agent.system_one(case["state"], case["questions"])
        ids = list(case["questions"].keys())
        assert len(encoded) == 1 and len(encoded[0]) == len(ids), case["id"]
        assert len(rows) == len(ids), case["id"]
        fingerprints = {
            qid: {"len": len(item["ids"]), "markers": [int(m) for m in item["markers"]], "fnv64": fnv64(item["ids"])}
            for qid, item in zip(ids, encoded[0])
        }
        probs = {}
        for qid, p in zip(ids, rows):
            probs[qid] = p
        golden.append({"id": case["id"], "response": res, "fingerprints": fingerprints, "probs": probs})
        print(case["id"], {q: a.get("choice", a.get("score", a.get("noul"))) for q, a in res["answers"].items()})

    spec = CHECKPOINTS[args.checkpoint]
    meta = {
        "laya_version": laya.__version__,
        "torch": torch.__version__,
        "device": "cpu",
        "dtype": "float32",
        "checkpoint": "%s@%s%s" % (spec["repo"], spec["revision"], " (%s)" % spec["subfolder"] if spec.get("subfolder") else ""),
        "max_len": agent.cfg.get("max_len", 512),
        "head_max_len": agent.cfg.get("head_max_len", 192),
    }
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"meta": meta, "golden": golden}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote", args.out, len(golden), "cases")


if __name__ == "__main__":
    main()
