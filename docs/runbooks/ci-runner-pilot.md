# Running the CI runner pilot

The P0 pilot of CI runners on a Mac (T214, issue
[#1038](https://github.com/nekko-labs/nekko-agent/issues/1038)): one of our own Macs takes this
repo's Native iOS jobs, each in a throwaway VM, with the hosted Mac as the fallback. Steps marked
**[Philip]** need his accounts, hardware or network; an agent stops there.

`<data>` below is Nekko's data folder, `~/.nekko-agent` unless `NEKKO_DATA_DIR` is set.

## Goal

One docked Mac runs `ios-native.yml` jobs for at least 7 days or 20 jobs, whichever is later,
with the hosted `macos-14` runner as the fallback. Done when the results are posted on #1038
(see [Record the results](#record-the-results)).

## What is still owed before the pilot can start

- **[Philip]** The VM boot check of the golden image ([image guide, Check it](../ci-runners-image.md#check-it)).
  Tart is not installed on the dev Mac yet: approve the Hypergate install request, then
  `brew install cirruslabs/cli/tart` lands. The Cirrus `macos-sequoia-base` image is already in
  Tart's cache, so the check needs no download.
- **[Philip]** A Developer ID signed build with `nekko-vm`, and notarization on the next tag: the
  checklist in [docs/signing.md](../signing.md#the-vm-helpers-entitlement). A dev build is
  enough for the pilot itself.
- **[Philip]** The GitHub App, its key, and connecting the Mac (below).
- **[Philip]** The Xcode image download (tens of GB) and the image build.
- **[Philip]** The `MAC_RUNNER_STATUS_TOKEN` secret and the `NEKKO_MAC_RUNNERS` variable, only after
  every check in [Security](#security-before-the-switch-goes-on) passes.

The pilot itself then owns: one real job end to end, the real-tunnel VPN check (Tailscale exit
node and subnet route), sleep and the lid (Testing R3), and the menu bar dot on a real menu bar.

## Before you start [Philip]

- [ ] An Apple silicon MacBook Pro on power, with an external display, on wired Ethernet or a
  trusted Wi-Fi network.
- [ ] A build of the stack with `nekko-vm`: a dev build (`node apps/desktop/scripts/stage-daemon.mjs --dev`
  stages and ad-hoc signs it), or the signed dist from [docs/signing.md](../signing.md#the-vm-helpers-entitlement).
- [ ] The GitHub App, created and installed on the `nekko-labs` org with access to
  `nekko-labs/nekko-agent` only, per [Create the GitHub App](../ci-runners.md#create-the-github-app)
  (the org runner's permissions: Organization **Self-hosted runners: Read and write**, Repository
  **Actions: Read and write**).
- [ ] The image, built from the Cirrus `macos-sequoia-xcode` base with
  [the image guide](../ci-runners-image.md), and its VM boot check passed.

## Connect the Mac

1. Workflows tab, **CI runners**, **Connect GitHub**.
2. Step 1: the App ID, installation ID and private key.
3. Step 2: **An org**, `nekko-labs`, repos `nekko-agent`, tick **Allow public repos**
   (nekko-agent is public), label `nekko-mac`. An org runner is needed for the workflow
   restriction under [Security](#security-before-the-switch-goes-on): a repo runner has no runner
   group. Nekko creates the runner group `nekko-nekko-mac` limited to nekko-agent.
4. Step 3: **Balanced: in the background**. Then in the runner's settings set keep awake to
   **While a runner is active**. Balanced keeps one VM ready, so the picker can see an idle
   runner; in **Do not disturb: Only run when I'm idle** no VM is up until a job is queued, and
   the picker would always pick hosted.

Check: the card shows a ready slot, and GitHub lists one online runner with labels `self-hosted`,
`macOS`, `ARM64`, `nekko-mac`:

```bash
gh api orgs/nekko-labs/actions/runners --jq '.runners[] | [.name, .status, .busy, ([.labels[].name] | join(","))] | @tsv'
```

## Security: before the switch goes on

nekko-agent is a public repo, and a `pull_request` run uses the PR's own copy of the workflow
file. A fork PR can therefore drop the picker and ask for `runs-on: [self-hosted, nekko-mac]`
directly: **the picker is not a boundary against fork code**. Two GitHub settings are the first
layer, and every one must be checked before `NEKKO_MAC_RUNNERS` is turned on:

1. **Fork PR workflows wait for approval from every outside contributor.** Repo **Settings >
   Actions > General > Approval for running fork pull request workflows from contributors >
   Require approval for all external contributors**, then **Save**. (Older GitHub pages call it
   "Require approval for all outside collaborators".) See GitHub's
   [Controlling changes from forks to workflows in public repositories](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories).
   Verify:

   ```bash
   gh api repos/nekko-labs/nekko-agent/actions/permissions/fork-pr-contributor-approval --jq .approval_policy
   # expect: all_external_contributors
   ```

2. **The runner group serves this repo's iOS workflow only.** Org **Settings > Actions > Runner
   groups > nekko-nekko-mac**:
   - **Repository access**: **Selected repositories**, only `nekko-agent`, with public
     repositories allowed (Nekko set both at connect).
   - **Workflow access**: **Selected workflows**, exactly
     `nekko-labs/nekko-agent/.github/workflows/ios-native.yml@refs/heads/main, nekko-labs/nekko-agent/.github/workflows/ios-native.yml@refs/heads/ci/ios-batch`
     (the schedule runs on `main`; `ios-batch.yml` dispatches the batch on `ci/ios-batch`). Then
     **Save group**. See GitHub's
     [Managing access to self-hosted runners using groups](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
     ("Changing which workflows can access a runner group": full paths, refs fully qualified like
     `refs/heads/main`) and the
     [runner groups REST API](https://docs.github.com/en/rest/actions/self-hosted-runner-groups).
     If the org's plan does not offer **Selected workflows**, stop: the switch stays off.

   Verify:

   ```bash
   gh api orgs/nekko-labs/actions/runner-groups --jq '.runner_groups[] | select(.name=="nekko-nekko-mac") | {visibility, allows_public_repositories, restricted_to_workflows, selected_workflows}'
   # expect: visibility "selected", allows_public_repositories true, restricted_to_workflows true,
   # selected_workflows the two entries above
   gh api "orgs/nekko-labs/actions/runner-groups/$(gh api orgs/nekko-labs/actions/runner-groups --jq '.runner_groups[] | select(.name=="nekko-nekko-mac") | .id')/repositories" --jq '[.repositories[].full_name]'
   # expect: ["nekko-labs/nekko-agent"]
   ```

   Nekko keeps the group's workflow access when it updates the group; re-run the check after
   any reconnect.

With the restriction on, a run of `ios-native.yml` from any other ref (a labeled pull request
runs from `refs/pull/<n>/merge`, a branch dispatch from that branch) cannot use the Mac. So the
`pick` job runs only for the schedule and for dispatches on `main` or `ci/ios-batch`; a labeled
pull request never asks the picker and always runs on `macos-14`.

Allowing `ci/ios-batch` means the Mac trusts everyone with write access to the repo, not only
`main`: the batch branch carries the unreviewed code of open same-repo PRs (`ios-batch.yml` drops
fork PRs).

The second layer is the VM sandbox: each job runs in a throwaway clone whose only network is
the public internet through Nekko's NAT (no LAN, no host, no VPN routes), with no SSH, no agent
and no admin access inside. See [decision 0022](../decisions/0022-ci-runners-vm-and-network.md)
and the [Probe job](#probe-job) below.

## Runner status token and switch [Philip]

The runner is an org runner, which the repo's runner list does not show, so the picker lists
the org's runners.

1. A fine-grained personal access token from an **org admin** of `nekko-labs` (for anyone else the
   org runners endpoint answers 403 and the picker always falls back to hosted): resource owner `nekko-labs`, organization permission
   **Self-hosted runners: Read-only**, nothing else, 90-day expiry. See GitHub's
   [permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
   ("Organization permissions for Self-hosted runners", read, for
   `GET /orgs/{org}/actions/runners`). If the permissions show **Repositories** and **Account**
   tabs, the resource owner is still your own account: switch it to `nekko-labs` and an
   **Organizations** tab appears. If `nekko-labs` is not offered, the org does not allow
   fine-grained tokens yet (org **Settings > Personal access tokens**).
2. `gh secret set MAC_RUNNER_STATUS_TOKEN -R nekko-labs/nekko-agent` (paste the token at the prompt).
3. `gh variable set NEKKO_MAC_RUNNER_ORG --body nekko-labs -R nekko-labs/nekko-agent`. Without
   it the picker reads the repo's own runners (a repo runner, with a token holding repository
   **Administration: Read-only**).
4. Only after [Security](#security-before-the-switch-goes-on) passes:
   `gh variable set NEKKO_MAC_RUNNERS --body on -R nekko-labs/nekko-agent`.

Off again at any time: `gh variable set NEKKO_MAC_RUNNERS --body off -R nekko-labs/nekko-agent`.
With it off, the `pick` job is skipped and every run uses `macos-14` as before. A token that
lacks the permission gets a 403, and the picker falls back to hosted with `api 403` in its log.

## First job

```bash
gh workflow run ios-native.yml --ref main -R nekko-labs/nekko-agent
```

- The `pick` job's log says `runs-on ["self-hosted","nekko-mac"]: idle runner`.
- `protocol-and-build`'s runner name starts with the runner's prefix (the card shows it).
- The card's recent jobs show it `finished`, and `<data>/runners/vms` is empty afterward.

Then switch the runner **Off** on its card and run it again: the `pick` log says
`no idle runner` and the job runs on `macos-14`. Switch it back on.

## What to measure

One table per day. For each run:

```bash
gh api repos/nekko-labs/nekko-agent/actions/runs/<id>/jobs \
  --jq '.jobs[] | select(.name=="protocol-and-build") | [.runner_name, .created_at, .started_at, .completed_at, .conclusion] | @tsv'
```

- Queue time (`started_at - created_at`) and job time (`completed_at - started_at`), on the Mac
  and on hosted.
- The hosted baseline: the 20 most recent `ios-native.yml` runs before the pilot,
  `gh run list --workflow ios-native.yml --limit 20 --json databaseId,event -R nekko-labs/nekko-agent`,
  each through the command above.
- Failures by cause: test, infrastructure, lost.
- Picker fallbacks and why (the `pick` log's reason).
- Jobs stuck queued over 15 minutes: cancel, then re-run the whole run (not the job) so the
  picker asks again.
- Every line of `<data>/runners/audit.jsonl` whose `result` is not `finished`, with its
  `reason` and `seconds`.

## Sleep and the lid

Testing R3. **[Philip]**, on the physical Mac.

- **(a) Docked, lid closed mid-job.** Expect the job to keep running (clamshell mode with a
  display and power).
- **(b) Undocked on battery, lid closed mid-job for 5 minutes.** Expect: GitHub fails the job
  after it loses the runner; after wake, an `audit.jsonl` line with `result` `lost` and `reason`
  `["slept"]`; `<data>/runners/vms` empty before any new VM starts; the job re-run once and
  picked up by this Mac after wake.
- **(c) Timings.** Note the time from lid close to GitHub marking the job failed, and from wake
  to the re-run starting. Record that the re-run lands on the Mac, not hosted: the re-run keeps
  the first attempt's `pick` output (a hosted re-run would need a whole-run re-run, a follow-up
  only if waits are long). If the Mac does not come back, that re-run waits in the queue for up to
  24 hours: cancel it and re-run the whole run, so the picker asks again and picks hosted.

## Probe job

Testing R1 basics, in a live VM. Push a branch `runner-probe` holding
`.github/workflows/runner-probe.yml`:

```yaml
name: runner probe
on:
  push:
    branches: [runner-probe]
jobs:
  probe:
    runs-on: [self-hosted, nekko-mac]
    steps:
      - run: id
      - run: "! sudo -n true"
      - run: "! su admin -c true </dev/null"
      - run: "! nc -z -G 3 <host LAN address> 22"
      - run: "! curl -m 5 http://<router address>"
      - run: "! curl -m 5 http://100.100.100.100"
      - run: "! ls /Volumes/NEKKOSEED"
      - run: "! pgrep -l tart-guest"
      - run: "! (launchctl print system/com.openssh.sshd | grep -q 'state = running')"
      - run: |
          ls ~/probe-* 2>/dev/null && { echo "marker from an earlier run survived"; exit 1; }
          touch ~/probe-${{ github.run_id }}
```

Expect: `id` shows `runner`, not in `admin`; every other step passes because the command was
refused; the marker step passes on a second push too (no file from the first run). The runner
group's workflow restriction refuses this workflow, so add
`nekko-labs/nekko-agent/.github/workflows/runner-probe.yml@refs/heads/runner-probe` to
**Selected workflows** for the probe, and remove it afterward. Delete the branch afterward.

## VPN check owed by T212

**[Philip]**: it changes the Mac's network. Use the T211 spike example
(`cargo run -p nekkod --features spike --example runner_vm_spike`, base image, its SSH forward)
or a probe job.

- **(a)** Tailscale exit node on, the runner's **Let jobs use the internet directly while a VPN
  is on** off: the card shows the runner waiting with the VPN reason, and no VM starts.
- **(b)** The switch on: from the guest, `curl -s https://1.1.1.1/cdn-cgi/trace | grep ip=`
  equals the host's `curl -s --interface <physical interface> https://1.1.1.1/cdn-cgi/trace | grep ip=`,
  not the exit node's address.
- **(c)** Exit node off; a tailnet peer advertises a subnet route covering a public test range
  (for example `1.1.1.0/24`) and this Mac accepts routes: the host's `route -n get 1.1.1.1` shows
  a `utun` interface, while the guest's request still leaves with the physical interface's
  address.

Restore the Tailscale settings afterward.

## Record the results

A comment on #1038 with:

- Mac model, macOS, the image (`/usr/local/share/nekko-runner-image.json` from a job's log or
  the build VM), mode and keep awake, dates.
- Jobs on the Mac and on hosted; queue and job time medians and 90th percentiles side by side.
- Failures by cause; the R3 timings; probe results; VPN results (a, b, c); the menu bar dot seen
  on a real menu bar.
- Problems and follow-ups, each filed as an issue.

**Success line:** the Mac's median queue time is at most the hosted median; no lost job except
the induced ones; `vms/` empty after every job and every wake; every probe and VPN check
refused; no complaint from the Mac's owner about the Mac slowing down in Balanced.

If it holds, tick T214 in `TASKS.md`, and turn the `Pending` lines of T211 (VPN), T212 and T213
into done lines citing the comment.
