# Snapshots and element refs: what they change in an agent's browser task

Date: 2026-10-18. Raw data: [snapshot-refs.json](snapshot-refs.json). Harness and fixture: [flow-benchmark.md](flow-benchmark.md).

## What was added

`snapshot` (dedicated mode) returns the page title and a compact list of interactive elements from the accessibility tree, each with a ref. A ref works as the selector for click, fill, type, press, wait and extract. Here is the real reply on the fixture, scoped to `main` (`{"action":"snapshot","selector":"main"}`, 434 bytes):

```
Signup fixture
- heading "Join the list" [level=2, ref=e2]
- textbox "Email" [required, ref=e43]
- textbox "Name" [ref=e44]
- checkbox " Weekly digest" [checked=true, ref=e45]
- combobox [expanded=false, ref=e46]: Free
  - option "Free" [selected, ref=e48]
  - option "Pro" [ref=e49]
- button "Subscribe" [ref=e47]
Use a ref such as @e1 as the selector for click, fill, type, press, wait or extract. Refs expire when the page changes.
```

A whole-page snapshot (2,584 bytes) also lists the header and the 40 article links.

Refs are resolved by the native agent-browser process from its accessibility node, never by `querySelector`. An unknown or stale ref fails with `Unknown ref: e999. Take a new snapshot; refs expire when the page changes.` Refs are refused for `scroll` and as a snapshot scope.

## Strategies compared

The same flow (navigate, locate, wait and look again because the form renders after a 120 ms API call, fill email and name, submit, wait for and extract the confirmation, screenshot), located three ways:

| Strategy | Locate step |
|---|---|
| selectors | `evaluate` a script that lists form controls with id, type and label, then fill `#email`, `#name` and click `button[type=submit]` |
| snapshot | `snapshot` of the whole page, then fill and click by ref |
| snapshot-scoped | `snapshot` with `selector: "main"`, then fill and click by ref |

Conditions: Windows 11 10.0.26300, Ryzen 9 9950X3D, Electron 44.7.0 / Chromium 152.0.7977.130, native agent-browser 0.39.1, hidden-frame wake on (#769). The three arms alternate sample by sample: 12 fresh processes (arms take turns going first), then 20 fresh-chat and 20 warm-session rounds per arm in one process. Nearest-rank percentiles. "Reply text" is what the model reads (screenshot pixels excluded). "Request" is what the model writes: the JSON of its tool inputs.

## Results

| Fresh chat, n=20 per arm | selectors | snapshot | snapshot-scoped |
|---|---:|---:|---:|
| Tool calls per flow | 10 | 10 | 10 |
| Retries per flow | 1 | 1 | 1 |
| Reply text per flow, p50 | 6889 B | 11193 B | 6935 B |
| Request per flow, p50 | 986 B | 462 B | 512 B |
| Locate step p50 / p95 | 2.79 / 3.24 ms | 21.1 / 21.89 ms | 22.03 / 32.43 ms |
| Whole flow p50 / p95 | 465.22 / 475.69 ms | 424.18 / 466 ms | 435.32 / 489.66 ms |

| Warm session, n=20 per arm | selectors | snapshot | snapshot-scoped |
|---|---:|---:|---:|
| Reply text per flow, p50 | 6883 B | 11295 B | 6937 B |
| Request per flow, p50 | 980 B | 459 B | 509 B |
| Whole flow p50 / p95 | 378.32 / 394.93 ms | 357.1 / 399.45 ms | 348.48 / 414.72 ms |

Where the bytes go, one fresh-chat flow each:

| Step | selectors: reads / writes | snapshot: reads / writes | snapshot-scoped: reads / writes |
|---|---|---|---|
| locate, before the form renders | 2 / 273 B | 2283 / 21 B | 160 / 39 B |
| locate, after waiting | 559 / 273 B | 2584 / 21 B | 435 / 39 B |
| each fill | 13 / 85 and 77 B | 13 / 82 and 75 B | 13 / 89 and 82 B |
| submit | 3019 / 51 B | 3019 / 36 B | 3019 / 36 B |

## What this shows, and what it does not

- **Fewer things to write, not fewer calls.** On this fixture every strategy needs the same 10 calls and 1 retry. The model writes about half as much (986 to 462 bytes) and, more to the point, writes no script: it reads a list and picks refs, instead of composing a DOM query and then CSS selectors from its result.
- **A whole-page snapshot costs reading.** It is the largest reply in the flow because it lists every link (11193 against 6889 bytes per flow). Scoped to `main` it costs about the same as listing controls (6935 bytes). The tool description tells the model it can pass a selector.
- **Time is unchanged.** A snapshot takes about 20 ms against about 3 ms for the evaluate. The whole flow comes out a few tens of milliseconds faster p50 only because the snapshot's extra time is time the fixture's 120 ms form API would have spent anyway (the following `wait` is shorter by about the same amount). Read this as no time effect, not a speedup.
- **This fixture favours selectors.** Its fields have ids and labels, so one evaluate finds stable CSS selectors. Pages without ids, with duplicate labels, or with controls that are not form elements (custom buttons, menus) are where refs avoid guesswork and retries. That was not measured here, and no number is claimed for it.
- **No model in the loop.** These are scripted strategies, not a model choosing actions. Whether a model picks up snapshot from the description, scopes it, and recovers from a stale ref is still to be observed.

## Next

1. Observe a live model on real pages with and without snapshot (tool calls, retries, reply bytes, failures).
2. A fixture without ids and with custom controls, to measure where refs should help most.
