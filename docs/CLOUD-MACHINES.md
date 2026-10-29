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
- It stops when idle and keeps its disk; it is deleted when you say so or after a week unused.
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
