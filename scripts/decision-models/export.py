"""Export one Laya checkpoint to the ONNX files Nekko Agent's decision runtime loads.

    python export.py --checkpoint laya-en --out out/laya-en

writes, into `--out`:

- `model.onnx`: fp32, laya's own exporter recipe (`scripts/export_onnx.py` in laya: the dynamo
  exporter at opset 18 with dynamic batch, sequence and option counts, traced from batch-2
  dummies so no dimension is specialised), with `allowzero` cleared on every `Reshape`
  (DirectML refuses `allowzero=1`; no shape tensor in this graph holds a literal 0, so the
  result is identical).
- `model_fp16.onnx`: `convert_float_to_float16(keep_io_types=True)` after dropping the graph's
  stale `value_info`, with the rotary-angle nodes kept in fp32 where that measured closer to
  the reference (`fp16_rotary_fp32` in checkpoints.py, see `rotary_nodes`).
- `model_int8.onnx`: weight-only int8, `MatMulNBitsQuantizer` (8 bits, block 128, symmetric,
  `accuracy_level=4`). Laya's own `quantize_dynamic` recipe quantizes activations per tensor and
  flips 20 of 86 golden answers on the English checkpoint.
- `tokenizer.json`, `tokenizer_config.json`, `rl_agent_config.json`, `config.json` (the encoder's).

Build-time only (Python, torch, onnx, onnxruntime); see README.md. Nekko Agent itself runs the
result with ONNX Runtime from Rust.
"""
import argparse
import os
import shutil
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from checkpoints import CHECKPOINTS, load_agent  # noqa: E402


def export_fp32(agent, path):
    # Laya's scripts/export_onnx.py, verbatim in what matters: batch 2, 17 tokens, 3 markers, all
    # different and > 1, so torch.export specialises none of them.
    batch, seq_len, num_markers = 2, 17, 3
    inputs = (
        torch.randint(0, 100, (batch, seq_len), dtype=torch.long),
        torch.ones((batch, seq_len), dtype=torch.long),
        torch.tensor([[1, 5, 9]] * batch, dtype=torch.long),
        torch.ones((batch, num_markers), dtype=torch.bool),
        torch.zeros(batch, dtype=torch.long),
    )
    dynamic_axes = {
        "input_ids": {0: "batch_size", 1: "seq_len"},
        "attention_mask": {0: "batch_size", 1: "seq_len"},
        "marker_pos": {0: "batch_size", 1: "num_markers"},
        "marker_mask": {0: "batch_size", 1: "num_markers"},
        "qtype": {0: "batch_size"},
        "logits": {0: "batch_size", 1: "num_markers"},
        "act_logits": {0: "batch_size"},
    }
    tmp = path + ".tmp"
    os.makedirs(tmp, exist_ok=True)
    torch.onnx.export(
        agent.model,
        inputs,
        os.path.join(tmp, "model.onnx"),
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
        output_names=["logits", "act_logits"],
        dynamic_axes=dynamic_axes,
        dynamo=True,
    )
    import onnx

    model = onnx.load(os.path.join(tmp, "model.onnx"), load_external_data=True)
    cleared = 0
    for node in model.graph.node:
        if node.op_type == "Reshape":
            for attr in node.attribute:
                if attr.name == "allowzero" and attr.i != 0:
                    attr.i = 0
                    cleared += 1
    print("allowzero cleared on %d Reshape nodes" % cleared)
    opset = [o.version for o in model.opset_import if o.domain in ("", "ai.onnx")]
    print("opset", opset)
    # One file: the fp32 graph is under protobuf's 2 GB limit for every Laya checkpoint.
    onnx.save_model(model, path, save_as_external_data=False)
    shutil.rmtree(tmp, ignore_errors=True)
    return model


def rotary_nodes(graph):
    """The rotary-embedding angle computation: `Cos`/`Sin` and everything feeding them.

    The angles are `position * inv_freq`, up to ~500 rad at 512 tokens and ~1000 at 1024; fp16
    resolves 0.25 rad at 500, so converting them moves every attention score. Kept in fp32 they
    are a handful of tiny nodes, and fp16 on DirectML stays within the golden test's 0.02.
    """
    producer = {o: n for n in graph.node for o in n.output}
    seen, stack = set(), [n for n in graph.node if n.op_type in ("Cos", "Sin")]
    while stack:
        n = stack.pop()
        if n.name in seen:
            continue
        seen.add(n.name)
        stack.extend(producer[t] for t in n.input if t in producer)
    return sorted(seen)


def topological(graph, nodes):
    """`nodes` reordered so every input is produced before it is read (the converter appends
    the Casts it inserts at the end; ONNX Runtime sorts them itself, the ONNX checker refuses)."""
    ready = {i.name for i in graph.input} | {i.name for i in graph.initializer} | {""}
    pending, out = list(nodes), []
    while pending:
        rest = []
        for n in pending:
            if all(t in ready for t in n.input):
                out.append(n)
                ready.update(n.output)
            else:
                rest.append(n)
        if len(rest) == len(pending):
            raise ValueError("graph has a cycle or an unproduced input: %s" % rest[0])
        pending = rest
    return out


def export_fp16(model, path, rotary_fp32):
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16

    m = onnx.ModelProto()
    m.CopyFrom(model)
    # Stale intermediate types from the exporter are what broke the converter on other exports.
    del m.graph.value_info[:]
    keep = rotary_nodes(m.graph) if rotary_fp32 else []
    print("fp32 rotary nodes kept:", len(keep))
    m16 = convert_float_to_float16(m, keep_io_types=True, node_block_list=keep)
    # With a node block list the converter inserts one Cast per consumer of a tensor that
    # crosses the fp16/fp32 boundary, under the same output name: identical nodes, which ONNX
    # rejects as duplicate definitions. Keep the first of each.
    nodes, outputs = [], {}
    for n in m16.graph.node:
        key = tuple(n.output)
        if key in outputs:
            first = outputs[key]
            assert first.op_type == n.op_type == "Cast" and list(first.input) == list(n.input), (first, n)
            continue
        outputs[key] = n
        nodes.append(n)
    print("duplicate casts dropped:", len(m16.graph.node) - len(nodes))
    del m16.graph.node[:]
    m16.graph.node.extend(topological(m16.graph, nodes))
    onnx.checker.check_model(m16)
    onnx.save_model(m16, path, save_as_external_data=False)


def export_int8(fp32_path, path):
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    model = onnx.load(fp32_path)
    q = MatMulNBitsQuantizer(model, bits=8, block_size=128, is_symmetric=True, accuracy_level=4)
    q.process()
    onnx.save_model(q.model.model, path, save_as_external_data=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", choices=sorted(CHECKPOINTS), default="laya-en")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", choices=["fp32", "fp16", "int8", "files"], action="append",
                    help="Precisions to (re)write; all three by default. fp16 and int8 need model.onnx. "
                         "The tokenizer and configs are always written; `files` writes only them.")
    args = ap.parse_args()
    # The torch exporter prints emoji; a Windows console's code page cannot encode them.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    only = set(args.only or ["fp32", "fp16", "int8"])
    os.makedirs(args.out, exist_ok=True)
    # Fetched fresh rather than copied from the snapshot: loading the agent rewrites the cached
    # tokenizer_config.json in place (laya's `_fix_tokenizer_config`), and the release ships the
    # checkpoint's own bytes.
    from huggingface_hub import hf_hub_download

    spec = CHECKPOINTS[args.checkpoint]
    for rel, name in [("tokenizer/tokenizer.json", "tokenizer.json"),
                      ("tokenizer/tokenizer_config.json", "tokenizer_config.json"),
                      ("rl_agent_config.json", "rl_agent_config.json"),
                      ("encoder/config.json", "config.json")]:
        got = hf_hub_download(spec["repo"], rel, revision=spec["revision"], force_download=True,
                              local_dir=os.path.join(args.out, ".pristine"))
        shutil.copyfile(got, os.path.join(args.out, name))
    shutil.rmtree(os.path.join(args.out, ".pristine"), ignore_errors=True)

    fp32 = os.path.join(args.out, "model.onnx")
    model = None
    if "fp32" in only:
        agent = load_agent(args.checkpoint)
        model = export_fp32(agent, fp32)
        del agent
        print("wrote", fp32, os.path.getsize(fp32))
    if "fp16" in only:
        import onnx

        model = model or onnx.load(fp32)
        out = os.path.join(args.out, "model_fp16.onnx")
        export_fp16(model, out, CHECKPOINTS[args.checkpoint]["fp16_rotary_fp32"])
        print("wrote", out, os.path.getsize(out))
    if "int8" in only:
        out = os.path.join(args.out, "model_int8.onnx")
        export_int8(fp32, out)
        print("wrote", out, os.path.getsize(out))


if __name__ == "__main__":
    main()
