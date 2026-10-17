"""The Laya checkpoints Nekko Agent exports, pinned to laya's own reviewed revisions.

The SHAs are `laya.revisions.PINNED_REVISIONS` in laya 0.3.22; the weights at those commits are
byte-identical to the repos' `main` when this was written (same LFS SHA-256), so a pin never
changes what is exported, only guarantees it.
"""
import os

#
# `fp16_rotary_fp32`: whether the fp16 file keeps the rotary-angle nodes in fp32 (export.py,
# `rotary_nodes`). fp16 rounding moves the 86 golden answers' probabilities by up to ~0.02
# either way and which questions it hits depends on the conversion, so this was measured per
# checkpoint against the golden test's 0.02 bound (max |dp|, DirectML / CPU):
#   laya-en               plain 0.0213 / 0.0074   rotary fp32 0.0186 / 0.0173
#   laya-multilingual     plain 0.0157 / 0.0029   rotary fp32 0.0343 / 0.0316
#   laya-typed-decisions  plain 0.0112 / 0.0026   rotary fp32 0.0057 / 0.0053
# Every option kept all 86 answers.
CHECKPOINTS = {
    "laya-en": {
        "repo": "convaiinnovations/laya",
        "revision": "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
        "fp16_rotary_fp32": True,
    },
    "laya-multilingual": {
        "repo": "convaiinnovations/laya-multilingual",
        "revision": "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
        "fp16_rotary_fp32": False,
    },
    "laya-typed-decisions": {
        "repo": "convaiinnovations/laya-typed-decisions",
        "revision": "1a793eb568e6718f15941d08f85432581df534e3",
        "fp16_rotary_fp32": True,
    },
}


def snapshot(name):
    """Download (or reuse) the checkpoint's files and return the local directory."""
    from huggingface_hub import snapshot_download

    spec = CHECKPOINTS[name]
    return snapshot_download(
        spec["repo"],
        revision=spec["revision"],
        allow_patterns=["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*", "config.json",
                        "README.md"],
    )


def load_agent(name):
    """The reference torch agent on the CPU in fp32."""
    os.environ.setdefault("USE_TF", "0")
    from laya.agent import Agent

    return Agent(snapshot(name), device="cpu", compile=False)
