#!/usr/bin/env bash
# The decision golden test and latency on CUDA, inside an NVIDIA CUDA 13 + cuDNN 9 container:
#
#   docker run --rm --gpus all -v <repo>:/src:ro -v <exports>:/models:ro \
#     -v nekko-cuda-target:/target -v nekko-cuda-cargo:/root/.cargo -v nekko-cuda-ort:/ort \
#     nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04 bash /src/scripts/decision-models/cuda-golden.sh
#
# /models holds one folder per checkpoint (laya-en, laya-multilingual, laya-typed-decisions).
#
# Links nekko-decide against Microsoft's ONNX Runtime 1.28.3 CUDA 13 build (dynamically, pinned
# by SHA-256), not the prebuilt the `cuda` feature downloads by default: pyke's build only
# carries kernels for sm_75, sm_80 and sm_90, so on a Blackwell GPU (RTX 50 series, sm_120)
# every session falls back to the CPU ("no kernel image is available for execution on the
# device"). Microsoft's carries sm_75 to sm_120 plus sm_120 PTX.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive CARGO_TARGET_DIR=/target
ORT_URL=https://github.com/microsoft/onnxruntime/releases/download/v1.28.3/onnxruntime-linux-x64-gpu_cuda13-1.28.3.tgz
ORT_SHA256=33e91f819324449bede2d1e853c8d46bb6253fa8890bac98ae676f041c8f73a6
if ! command -v cc >/dev/null || ! command -v curl >/dev/null; then
  apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config libssl-dev ca-certificates >/dev/null
fi
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN:-1.96.0}" >/dev/null
fi
. "$HOME/.cargo/env"
mkdir -p /ort
if [ ! -d /ort/lib ]; then
  curl -sSfL -o /ort/ort.tgz "$ORT_URL"
  echo "$ORT_SHA256  /ort/ort.tgz" | sha256sum -c -
  tar xzf /ort/ort.tgz -C /ort --strip-components=1
fi
export ORT_LIB_LOCATION=/ort/lib ORT_PREFER_DYNAMIC_LINK=1 LD_LIBRARY_PATH=/ort/lib
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
du -chL /ort/lib/libonnxruntime*.so* | sed "s/^/ONNX Runtime libraries: /"
cd /src
cargo build --release --locked -p nekko-decide --features cuda --tests --examples 2>&1 | tail -n 2
golden=$(ls -t /target/release/deps/golden-* | grep -v '[.]d$' | head -n1)
for dir in /models/*/; do
  name=$(basename "$dir")
  case "$name" in laya-en) g=en ;; laya-multilingual) g=multilingual ;; laya-typed-decisions) g=typed-decisions ;; *) continue ;; esac
  for p in fp32 fp16; do
    echo "== $name $p cuda"
    LAYA_MODEL_DIR="$dir" LAYA_GOLDEN=$g LAYA_PRECISION=$p LAYA_EP=cuda LAYA_GOLDEN_REPORT=1 \
      "$golden" --test-threads 1 --nocapture 2>&1 | grep -E 'answers \(|preprocessing:|argmax flips|panicked' || true
  done
done
for m in laya-en laya-multilingual laya-typed-decisions; do
  [ -d "/models/$m" ] || continue
  for p in fp16 fp32; do
    echo "== latency $m $p cuda"
    /target/release/examples/latency "/models/$m" cuda "$p" 100 2>&1 | grep -E 'loaded|question|fallbacks'
  done
done
echo "== latency laya-en fp32 cpu (what Linux release builds run)"
/target/release/examples/latency /models/laya-en cpu fp32 10 2>&1 | grep -E 'loaded|question'
