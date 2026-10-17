#!/usr/bin/env bash
# Checks decision models on CoreML on a real Mac (Apple silicon), from a checkout of this repo:
#
#   bash scripts/decision-models/mac-check.sh [checkpoint ...]
#
# Downloads the exports from the decision-models-v1 release into ~/nekko-decision-check
# (about 2.5 GB for laya-en fp16 + fp32; checked against SHA256SUMS), builds the runtime, runs
# the golden test with CoreML requested and then on the CPU, and the latency example. Prints a
# summary to paste into the PR or TASKS.md. Needs Rust (rustup.rs) and the GitHub CLI (gh).
# Delete ~/nekko-decision-check afterwards to get the space back.
set -uo pipefail
cd "$(dirname "$0")/../.."
checkpoints=${*:-laya-en}
work="$HOME/nekko-decision-check"
mkdir -p "$work"
echo "Mac: $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion), $(uname -m)"
[ "$(uname -m)" = arm64 ] || { echo "This needs an Apple silicon Mac."; exit 1; }

( cd "$work"
  gh release download decision-models-v1 --repo nekko-labs/nekko-agent --pattern SHA256SUMS --clobber
  for c in $checkpoints; do
    for f in tokenizer.json tokenizer_config.json rl_agent_config.json config.json model_fp16.onnx model.onnx; do
      mkdir -p "$c"
      [ -f "$c/$f" ] && continue
      gh release download decision-models-v1 --repo nekko-labs/nekko-agent --pattern "$c.$f" --clobber || exit 1
      want=$(awk -v f="$c.$f" '$2 == f { print $1 }' SHA256SUMS)
      got=$(shasum -a 256 "$c.$f" | cut -d' ' -f1)
      [ "$want" = "$got" ] || { echo "checksum mismatch: $c.$f"; exit 1; }
      mv "$c.$f" "$c/$f"
    done
  done ) || exit 1

cargo build --release --locked -p nekko-decide --tests --examples || exit 1
golden=$(ls -t target/release/deps/golden-* | grep -v '[.]d$' | head -n1)
summary=()
for c in $checkpoints; do
  case $c in laya-en) g=en ;; laya-multilingual) g=multilingual ;; laya-typed-decisions) g=typed-decisions ;; *) continue ;; esac
  for ep in coreml cpu; do
    for p in fp16 fp32; do
      out=$(LAYA_MODEL_DIR="$work/$c" LAYA_GOLDEN=$g LAYA_PRECISION=$p LAYA_EP=$ep LAYA_GOLDEN_REPORT=1 \
        "$golden" --test-threads 1 --nocapture 2>&1)
      line=$(echo "$out" | grep -E 'answers \(' | sed 's/.*answers/answers/')
      tokens=$(echo "$out" | grep -E 'preprocessing:' | sed 's/.*preprocessing: //')
      summary+=("$c $p, $ep requested: ${line:-FAILED} | ${tokens:-no token check}")
      echo "$out" | grep -E 'panicked' && echo "$out" | tail -n 20
    done
  done
done
echo
echo "== latency (laya-en)"
for ep in coreml cpu; do
  for p in fp16 fp32; do
    echo "-- $ep $p"
    ./target/release/examples/latency "$work/laya-en" $ep $p 20 2>&1 | tail -n 4
  done
done
echo
echo "== summary (\"on coreml\" means CoreML ran it; \"on cpu\" with coreml requested is a fallback, and the latency run above prints why)"
printf '%s\n' "${summary[@]}"
