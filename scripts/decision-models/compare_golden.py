"""Compare two golden files from reference.py: token fingerprints and usage must be identical,
probabilities within --tol. Used to check a regenerated reference against the committed one.

    python compare_golden.py a.json b.json [--tol 1e-5]
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--tol", type=float, default=1e-5)
    args = ap.parse_args()
    a = {g["id"]: g for g in json.load(open(args.a, encoding="utf-8"))["golden"]}
    b = {g["id"]: g for g in json.load(open(args.b, encoding="utf-8"))["golden"]}
    assert a.keys() == b.keys(), "different cases"
    worst, at, problems, questions = 0.0, "", [], 0
    for cid in a:
        ga, gb = a[cid], b[cid]
        if ga["fingerprints"] != gb["fingerprints"]:
            problems.append("%s: token fingerprints differ" % cid)
        if ga["response"]["usage"] != gb["response"]["usage"]:
            problems.append("%s: usage differs" % cid)
        for qid, pa in ga["probs"].items():
            questions += 1
            pb = gb["probs"][qid]
            for x, y in zip(pa, pb):
                if abs(x - y) > worst:
                    worst, at = abs(x - y), "%s / %s" % (cid, qid)
            ra, rb = ga["response"]["answers"][qid], gb["response"]["answers"][qid]
            if ra.get("choice") != rb.get("choice"):
                problems.append("%s / %s: choice %r vs %r" % (cid, qid, ra.get("choice"), rb.get("choice")))
    print("%d cases, %d questions, max |dp| %.2e at %s" % (len(a), questions, worst, at))
    for p in problems:
        print("  " + p)
    sys.exit(1 if problems or worst > args.tol else 0)


if __name__ == "__main__":
    main()
