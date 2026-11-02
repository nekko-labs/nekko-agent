# Attachment added after the run

`powermetrics.txt` was recorded alongside this run with
`sudo powermetrics --samplers gpu_power,thermal -i 2000`, started before the run
and stopped after it, so it also covers some minutes after the last request.
It was copied here after the run; `manifest.json` and `raw.jsonl` are untouched.

What it shows, aligned with the request times in `raw.jsonl`:

- Thermal pressure went from Nominal to Moderate about 2 minutes into the
  preheat and to Heavy about 3 minutes in, and stayed Heavy.
- Plain llama-server's decode did not follow the GPU clock: it fell from 96 to
  89 tok/s at ~1,550 MHz, rose back to 95 as pressure turned Heavy, and ended at
  87.6 with the clock about 15% lower. The cause of its swings is not known.
- mlx-lm held near 106.5 tok/s and fell to about 102 from ~330 s, with its GPU
  clock nearly unchanged.
- At the start, GPU power was about 42 W for mlx-lm at 108 tok/s and 50 W for
  llama-server at 96 tok/s: roughly 0.39 against 0.52 J per token, GPU only,
  one run.
