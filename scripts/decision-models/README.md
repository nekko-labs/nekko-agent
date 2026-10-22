# Decision model exports

How the Laya ONNX files on the `decision-models-v1` release were made, so anyone can rebuild
them byte for byte from the pinned checkpoints and check them against the golden test.
Python is used here, at build time only; Nekko Agent runs the result from Rust.

| file | what it does |
| --- | --- |
| `checkpoints.py` | the three checkpoints, pinned to laya's reviewed revisions |
| `export.py` | one checkpoint to `model.onnx` (fp32), `model_fp16.onnx`, `model_int8.onnx` plus tokenizer and configs |
| `reference.py` | what the official `laya` package answers for `crates/nekko-decide/tests/golden/cases.json` (CPU, fp32) |
| `compare_golden.py` | two reference files agree (token fingerprints exact, probabilities within a tolerance) |
| `stage-release.py` | names the files as release assets, writes `SHA256SUMS`, prints the catalog sizes and digests |
| `LICENSE`, `NOTICE` | upstream's Apache-2.0 license and what was changed, shipped with the assets |

## Rebuild

In a throwaway virtual environment (Windows shown; on Linux use `venv/bin/python`):

```bat
uv venv --python 3.12 venv
uv pip install --python venv\Scripts\python.exe -r scripts\decision-models\requirements.txt ^
  --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match
set USE_TF=0
for %c in (laya-en laya-multilingual laya-typed-decisions) do venv\Scripts\python.exe scripts\decision-models\export.py --checkpoint %c --out out\%c
```

The export needs about 12 GB of RAM and a few minutes per checkpoint on a CPU.

## Check

```bat
rem the English reference reproduces the committed golden file
venv\Scripts\python.exe scripts\decision-models\reference.py --checkpoint laya-en --out ref-en.json
venv\Scripts\python.exe scripts\decision-models\compare_golden.py crates\nekko-decide\tests\golden\golden.json ref-en.json

rem each export against its checkpoint's reference, per precision and provider
set LAYA_MODEL_DIR=out\laya-en
set LAYA_PRECISION=fp16
set LAYA_EP=directml
cargo test --release -p nekko-decide --test golden -- --nocapture
```

`LAYA_GOLDEN=multilingual` or `typed-decisions` picks the other references. Results are in
[docs/decision-models.md](../../docs/decision-models.md).

## Publish

```bat
venv\Scripts\python.exe scripts\decision-models\stage-release.py --exports out --stage release
gh release create decision-models-v1 release\* --repo nekko-labs/nekko-agent --latest=false ...
```

Never as the latest release: the app's updater reads `releases/latest`. Copy the printed sizes
and digests into the daemon's catalog (`crates/nekkod/src/decision-catalog.json`), and edit the
`catalog` reply recorded in `crates/nekkod/tests/golden/decisions.json` to match by hand (see
[docs/runbooks/golden-fixtures.md](../../docs/runbooks/golden-fixtures.md)).
