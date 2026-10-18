# Experimental outbound resource queue

Private coordinator: https://github.com/nekko-labs/nekko-agent-server

Enable Settings > Experimental > Developer resource queue. Model Server then shows connection, registration and manual queue controls. A claim seeds a new chat; the user reviews the prompt and sends it with their selected model. No automatic pickup, inbound listener, or implicit local/cloud model selection. Return to Model Server to submit the final reply. Submission is untrusted and not verified success.

## Current restrictions and release gates

This is a draft foundation, not ready for public deployment. The server supports one shared client credential, not individual client authorization/revocation. The client credential is stored in a host-side local file, outside settings and renderer storage, but is not encrypted and Windows ACL protection is not established. Do not use production secrets until OS-backed secret storage is implemented.

Assignment state is in component memory. Closing/restarting loses it and renewal stops; the five-minute lease eventually requeues the job. Recovery/cancellation and durable host-side heartbeats are required. Connection changes during a claim must be blocked in the next iteration. Submitted output and remote JSON require stronger typed validation and streaming response caps. Generic agent prompts are not a sandbox: review hostile prompts and retain normal tool approval settings.

Independent server verification, signed GitHub webhook ingestion, current-head validation and approval submission are not implemented. No endpoint authorizes APPROVE. Fly configuration exists in the server repository but has not been provisioned or tested; volume permissions, backups, per-client identity, ingress limits and audit logging are deployment gates.

Checks: queue HTTP/auth/lease tests; client typecheck with generated worktree shared declarations. Desktop visual verification and a live client/server walkthrough remain outstanding.
