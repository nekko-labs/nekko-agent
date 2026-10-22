"""Stage the exports as release assets and print the catalog entries for them.

    python stage-release.py --exports out --stage release

For each checkpoint folder under `--exports` (`laya-en`, `laya-multilingual`,
`laya-typed-decisions`), copies every file to `--stage` as `<checkpoint>.<file>` (assets of one
GitHub release share a namespace), adds LICENSE and NOTICE, writes `SHA256SUMS`, and prints the
`variants` / `shared` lists (size and SHA-256 of every file) that
`crates/nekkod/src/decision-catalog.json` pins.

Publish with:

    gh release create decision-models-v1 release/* --repo nekko-labs/nekko-agent \\
      --title "Decision models v1" --notes-file release-notes.md --latest=false
"""
import argparse
import hashlib
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from checkpoints import CHECKPOINTS  # noqa: E402

MODEL_FILES = [("fp16", "model_fp16.onnx"), ("int8", "model_int8.onnx"), ("fp32", "model.onnx")]
SHARED = ["tokenizer.json", "tokenizer_config.json", "rl_agent_config.json", "config.json"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exports", required=True)
    ap.add_argument("--stage", required=True)
    args = ap.parse_args()
    os.makedirs(args.stage, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    sums = []
    catalog = {}
    for name in CHECKPOINTS:
        src = os.path.join(args.exports, name)
        if not os.path.isdir(src):
            print("skipping", name, "(not exported)")
            continue
        entry = {"variants": [], "shared": []}
        for kind, files in (("variants", MODEL_FILES), ("shared", [(None, f) for f in SHARED])):
            for precision, f in files:
                path = os.path.join(src, f)
                asset = "%s.%s" % (name, f)
                shutil.copyfile(path, os.path.join(args.stage, asset))
                digest = sha256(path)
                sums.append("%s  %s" % (digest, asset))
                row = {"file": f, "asset": asset, "bytes": os.path.getsize(path), "sha256": digest}
                if precision:
                    row = {"precision": precision, **row}
                entry[kind].append(row)
        catalog[name] = entry
    for f in ("LICENSE", "NOTICE"):
        shutil.copyfile(os.path.join(here, f), os.path.join(args.stage, f))
        sums.append("%s  %s" % (sha256(os.path.join(here, f)), f))
    with open(os.path.join(args.stage, "SHA256SUMS"), "w", newline="\n") as out:
        out.write("\n".join(sums) + "\n")
    print(json.dumps(catalog, indent=1))


if __name__ == "__main__":
    main()
