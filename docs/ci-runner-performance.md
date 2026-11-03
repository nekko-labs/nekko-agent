# CI runner performance

How fast a job runs on a Mac with [CI runners](ci-runners.md) compared with GitHub's own hosted
Macs, measured on Nekko Agent's own iOS CI. Every number here comes from a real GitHub Actions run
whose logs anyone with access to the repo can open.

## Headline

On a 2021 MacBook Pro, our iOS CI job took **39 minutes** in a throwaway VM, against **65 minutes**
for the same code on GitHub's hosted Mac that day: **40% less time**. Against the hosted job's usual
47 minutes it was still **16% faster**. App builds were **2.6x** faster, the Rust build **1.8x**, and
the simulator test suite finished in a little over half the time.

The Mac was an **Apple M1 Max**, first-generation Apple silicon from 2021. Newer Macs (M2 to M5) have more
and faster cores, so they should be faster still; that is expected, not yet measured.

## Native iOS, 2026-11-03

**Job:** `protocol-and-build` in [`ios-native.yml`](../.github/workflows/ios-native.yml): Swift
protocol tests, a Rust build of `nekkod`, a relay round trip, the app build for the simulator, then
the unit, UI and live phone journey tests in light and dark with screenshots. Both runs were
dispatched on `main` 32 minutes apart, and both started with no Rust cache (each restore logged
"No cache found"), so neither had a head start.

| | This Mac | GitHub-hosted |
| --- | --- | --- |
| Run | [41631154641](https://github.com/nekko-labs/nekko-agent/actions/runs/41631154641) | [41626871704](https://github.com/nekko-labs/nekko-agent/actions/runs/41626871704) |
| Result | passed | passed |
| Machine | MacBook Pro (MacBookPro18,2), Apple M1 Max, 10 cores, 64 GB, macOS 27.2 | `xcode-27-arm64` image 20261026.0314.1, macOS 27.0.1 |
| The job's share | one VM: 6 vCPUs, 10 GB (the Balanced mode default) | the whole hosted machine |
| Wait for a runner | 4 s | 3 s |

| Step | This Mac | GitHub-hosted | Faster by |
| --- | --- | --- | --- |
| Protocol and app-state tests | 71 s | 85 s | 1.2x |
| `cargo build -p nekkod --locked` | 51 s | 94 s | 1.8x |
| Phone, relay and computer over URLSession | 46 s | 44 s | same |
| Build the app and its tests for the simulator | 47 s | 123 s | 2.6x |
| Simulator tests and live screenshots | 32.6 min | 58.1 min | 1.8x |
| Save the Rust cache | 69 s | 14 s | 4.9x slower |
| **Whole job** | **39.3 min** | **65.3 min** | **1.7x** |

The 172 earlier hosted runs of this job had a median of 47 minutes (range 2 to 71), so this
hosted run was a slow one. Against that median the Mac was still 8 minutes, about 16%, faster.

### Caveats

- One run on each side. Treat these as a first reading, not a median.
- Wall-clock step times from the GitHub API, which rounds to the second.
- The Mac was a laptop on a home network in Balanced mode, not a dedicated build machine.

### Why the cache save is slower

The one step the Mac loses is uploading the Rust cache to GitHub, and most of that is compression.
The runner image has no GNU tar or `zstd`, so `actions/cache` falls back to the system `tar` with
gzip. Hosted images ship both and get zstd.

| Save | This Mac | GitHub-hosted |
| --- | --- | --- |
| Archive | `/usr/bin/tar`, gzip, `cache.tgz` | `gtar`, zstd, `cache.tzst` |
| Size | 365 MB | 322 MB |
| Compress | 28 s | 5 s |
| Upload | 34 s, about 11 MB/s, with stalls | 1 s, inside GitHub's network |

A cache's version includes its compression and its paths, so the two kinds never restore each
other's caches either. Adding `zstd` and `gnu-tar` to the image would cut the compression and the
size; the upload stays bound by the Mac's own internet connection.

## What the job used, and how big a VM it needs

A third run of the same job ([41640874762](https://github.com/nekko-labs/nekko-agent/actions/runs/41640874762),
passed, 39 minutes, warm Rust cache) was sampled from the host every 5 seconds: the VM process's CPU
time, its memory, and the Mac's GPU use. The VM had 6 vCPUs and 10 GB.

**CPU: 6 vCPUs fits this job.** It averaged 2.7 busy vCPUs over the job, but the work comes in bursts:

| Busy vCPUs | Share of the job |
| --- | --- |
| under 3 | 68% |
| 3 to 5 | 18% |
| 5 or more (all 6 nearly full) | 14% |

The app build averaged 4.0 vCPUs and the simulator tests 2.9, with bursts to all 6 when tests run in
parallel. Four vCPUs would stretch every burst; eight could shorten only the 11% of the job where all
six were full, a minute or so at most.

| Step | Avg busy vCPUs |
| --- | --- |
| Protocol and app-state tests | 1.5 |
| `cargo build -p nekkod` (cache hit) | 2.3 |
| Phone, relay and computer over URLSession | 0.3 |
| Build the app and its tests for the simulator | 4.0 |
| Simulator tests and live screenshots | 2.9 |

**Memory: the VM holds all of it from boot.** The VM process's physical footprint is the full 10 GB
even while a warm VM waits for a job, because macOS in the guest touches all of its memory. Every
gigabyte given to a VM is taken from the host whether or not the job needs it. The resident size seen
from the host rose to 18.9 GB during the simulator tests, most of it graphics surfaces shared with the
host's GPU process, so it overstates what the VM costs. The host never left normal memory pressure.
How much of the 10 GB the job really uses can only be read inside the guest. That is not measured
yet; GitHub's standard runner passes this job with 7 GB.

**GPU: nothing to size.** A VM gets a paravirtualized GPU that shares the host's; there is no core or
memory setting for it. The Mac's GPU averaged 13% during the simulator tests, a figure for the whole
Mac, the owner's apps included.

## Measure it yourself

Dispatch [`ios-native.yml`](../.github/workflows/ios-native.yml) on `main` with
`NEKKO_MAC_RUNNERS` on and an idle runner, then compare the job's steps with a hosted run:

```bash
gh api repos/<owner>/<repo>/actions/runs/<run>/jobs -q '.jobs[].steps[] | [.name, .started_at, .completed_at] | @tsv'
```
