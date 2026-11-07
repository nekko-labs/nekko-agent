# Nekko Cloud machines

> **Status:** first build, not yet live. The pieces exist in the code (the Cloud API, the
> machine image, the iPhone screens); nothing is deployed, and the egress limits are not yet
> enforced outside the machine. See `spec/phone/nekko-cloud-machines.md`.

A Nekko Cloud machine is a sandboxed computer in the cloud that your phone pairs with like any
other computer, so you can use cloud models from your phone with no computer of your own
switched on. It is part of Nekko Cloud Pro and Team.

## What it is

- The same engine and image you can self-host (`ghcr.io/nekko-labs/nekko-agent`), started for
  you on a small machine (2 vCPUs, 4 GB, 20 GB disk) in a region near you, with no public
  address. It only dials out: to the relay, to GitHub and to the providers you set up.
- To the phone it is a computer: the same end-to-end encrypted relay, the same chat, approvals,
  files, git and pull requests, the same computer page.
- It stops itself after 15 minutes with no device connected and no chat running, and keeps its disk.
  It is deleted when you say so, or after 7 days unused. Hours count only while it runs.
  Your chats sync back to your account end-to-end encrypted, so nothing is lost when it sleeps.

## What the cloud may see

You decide, per machine, and nothing else reaches it. The defaults are the minimum:

| | Default |
| --- | --- |
| Repositories it may clone | none; add `owner/repo` on the machine's page |
| Model providers | none; a key you add is sealed to the machine and never held by Nekko Labs |
| Privacy Shield on every cloud model request | on |
| Memory, rules and saved prompts from your computers | off |
| Connectors | not offered yet |
| Sync chats back to your account | on, end-to-end encrypted |

A cloud machine is never paired with your own computers and never receives their credentials,
folders or terminals. Nekko Labs operators have no shell into your machine by policy, and it
holds no chat text that sync has not already sealed.

## From the phone

- **Settings → Nekko Cloud → Machines**: your machines, and **New machine**, which makes one and
  pairs it in one step.
- **New chat → Nekko Cloud**: run the chat on your machine (or make one).
- **Computers → the machine**: its state, region and hours, **Stop** and **Start**, the scope
  above, and **Stop and delete this machine**.

## Deploying

Four Fly apps in the Nekko Labs org, deployed in this order. Each step is checked before the next.

1. **Sign-in.** A Supabase project for Nekko Cloud (identity only, decision 0005) with email
   codes on; its settings go on the API as in `apps/nekko-agent-api/README.md`.
2. **`nekko-cloud-machines`**, which holds every user machine and serves nothing. Create it with no
   IP addresses, push the image to Fly's registry and note its digest:
   `fly apps create nekko-cloud-machines`, then
   `fly deploy --build-only --push -a nekko-cloud-machines --image-label <git sha> .`
   (from the repo root, which builds the root `Dockerfile`). Make a deploy token for this app
   only: `fly tokens create deploy -a nekko-cloud-machines`.
3. **`nekko-agent-api`** (`apps/nekko-agent-api/fly.toml`): set `FLY_API_TOKEN` (that token) and
   `NEKKO_MACHINE_IMAGE=registry.fly.io/nekko-cloud-machines@sha256:<digest>`, then `fly deploy`.
   It runs migrations on boot and stays on, because the hours sweep and the 7-day delete run in it.
4. **`nekko-agent-relay`** (`apps/relay-server/fly.toml`, one machine): its agents must hold a
   machine's token, checked at `https://nekko-agent-api.fly.dev/v1/relay/authorize`.
   `fly deploy -c apps/relay-server/fly.toml --dockerfile apps/relay-server/Dockerfile .`

Then a real run: make a machine from the phone, chat, leave it 15 minutes, check it stopped and
its hours stop with it, start it again and check the phone is still paired, then delete it and
check `fly volumes list -a nekko-cloud-machines` is empty.
