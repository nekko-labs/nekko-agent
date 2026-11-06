# Local inference benchmarks: runner and results

How fast local runtimes run the same model on the same Mac: Nekko Agent, plain
llama.cpp (`llama-bench`, `llama-server`), Ollama, LM Studio (GGUF and MLX) and
mlx-lm. It measures speed, not model quality. Results: [REPORT.md](REPORT.md),
summarised on [the docs page](../docs/benchmarks.md).

Everything here is meant to be rerun, checked and improved: every number in the
report comes from a run folder below, and every run folder records how it was
measured.

## Layout

- `scripts/`: the runner. Standard-library Python 3, nothing to install.
  - `stream_bench.py`: time to first token, decode and prefill through each
    server's OpenAI-compatible streaming API, measured by the client the same
    way for every server. Several servers alternate request by request.
  - `llama_bench.py`: llama.cpp's own `llama-bench`, the engine with nothing in
    front, as a ceiling.
  - `conditions.py`: records the machine's state and decides whether a run can
    count.
  - `report.py`: rewrites the results section of `REPORT.md` from the run
    folders, re-checking every run against the current rules.
  - `code_edit_source.py`: the file the code-edit workload asks the model to edit.
- `runs/`: valid runs, one folder each: `raw.jsonl` (every request, with every
  token's arrival time and the reply's text) and `manifest.json` (server command
  lines and versions, the weights' sha256, the machine, power and process state
  before, during and after, the settings, the checks and the summary). Two runs
  also hold a `powermetrics.txt` record and a `NOTES.md` about it.
- `exploratory/`: runs that fail a check land here, with the reasons. Ignored
  by git.

## Running it

Start the servers you want to compare, each with the same weights, then:

```
python3 bench/scripts/stream_bench.py --name burst-chat-a-vs-b \
  --scenario burst --pause 20 \
  --target a=http://127.0.0.1:8080/v1 --target b=http://127.0.0.1:8090/v1 \
  --model <model name> --model-file <the .gguf, or an MLX model folder> --runs 8
python3 bench/scripts/report.py
```

- `--workload`: `chat` (a ~455-token prompt, 512 tokens generated), `chat-short`
  (a one-sentence question) or `code-edit` (rename a function in a 156-line file
  and return the whole file).
- `--scenario burst --pause 20` measures a cool chip; `--scenario sustained
  --preheat 420` measures after seven minutes of nonstop work.
- `--speculative` allows speculative decoding drafts; without it, a server that
  drafts fails the run.
- `--target-model` and `--target-model-file` give one server a different model
  name or weights (Ollama, LM Studio and mlx-lm name models differently).
- Keep plain `llama-server` in every comparison: it is the shared reference and
  shows whether the machine held still.

The exact command line of every server measured is in its run's
`manifest.json`.

## When a run is valid

The scripts check these and refuse to start, or file the run as exploratory:

- on AC power and not charging, Low Power Mode off, no thermal warning;
- no model process running except the servers measured (llama-server, Ollama's
  runner, mlx-lm, and LM Studio's workers, which hold models inside LM Studio);
- no other process above 50% CPU before or during the run;
- the scripts committed to git, so the code that ran is known;
- the weights named and hashed;
- a warmup request and at least 5 measured ones per server; at least 16 for a
  speculative decoding server on chat;
- every chat reply uses the full token budget; every code edit finishes on its
  own, and servers on the same edit generate the same length within 2%;
- decode moves less than 3% from the first requests to the last. A speculative
  decoding server on chat is exempt, since its speed follows each reply, and
  the servers without drafts must hold still instead;
- no speculative decoding drafts unless the run is about them.

## About the recorded data

- Before these files were added here, `~` replaced the home directory in every
  path, and processes that were not part of a measurement keep only their
  executable's name and CPU figure: their arguments could hold anything. The
  measured servers' command lines are complete.
- The runs were measured from 2026-10-27 to 2026-10-30, while the runner was
  developed in a separate repository; the `scripts.commit` in their manifests
  names commits there. The checks those runs passed are the ones `report.py`
  applies today, and it lists apart any run that fails the current rules.
