# Attachment added after the run

`powermetrics.txt` was recorded alongside this run with
`sudo powermetrics --samplers gpu_power,thermal -i 2000`, started before the run
and stopped after it. It was copied here after the run; `manifest.json` and
`raw.jsonl` are untouched.

What it shows, aligned with the request times in `raw.jsonl` (GPU only, one run,
2-second samples, so per-request figures are approximate):

- Thermal pressure went Nominal, then Moderate about 2 minutes in, then Heavy
  about 3 minutes in, and stayed Heavy.
- Over the run, decode fell 12.8% for Nekko with speculative decoding, 8.8% for
  plain llama-server and 6.1% for mlx-lm: speculative decoding was the most
  sensitive to heat. Its decode fell more than its GPU clock did (-5.5%), so
  the clock alone does not explain it.
- Nekko with speculative decoding drew the most GPU power (56-65 W at the
  start, against about 51 W for llama-server and 37-40 W for mlx-lm), but per
  token it used far less energy: about 0.08 J per token, against about 0.55 for
  llama-server and 0.36 for mlx-lm at the start, and about 0.075, 0.38 and 0.34
  under Heavy pressure.
