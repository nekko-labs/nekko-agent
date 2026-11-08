---
status: proposed
date: 2026-11-08
---

# 0068. Make local video clips as jobs on the model's own sd-server, returned as animated WebP, in Photo chats until the Video chat lands

## Context

Wan 2.2 TI2V 5B runs on the stable-diffusion.cpp build Nekko already ships, but only through sd-server's native async video API: `POST /sdcpp/v1/vid_gen` returns a job, read with `GET /sdcpp/v1/jobs/{id}` until it completes, with the clip as one encoded container. The engine's router picks a model process by the `model` field of a request body, which a job read does not have. The Video chat type is in PR #2149, still a draft. These choices were made overnight without review, at Davide's request (spec: [Photo and Video models](../../spec/models/photo-and-video-models.md), "Local video clips").

## Options considered

1. **Route clips through the router:** teach it `/sdcpp/v1/*`, remembering which process owns each job id. One entry point for every client, but the router gains per-job state it does not have today, for a feature with one caller.
2. **The daemon talks to the model's own sd-server** after loading the model the usual way, holding it busy for the job, and cancelling the job when the turn stops. No router change; only the daemon can make clips, which is the only caller there is.
3. **Output format:** WebM plays in a video element but needs an sd-server built with WebM and fails the request otherwise; animated WebP plays in the picture element the transcript already has; AVI (MJPG) is large and Chromium does not play it.
4. **Where clips are made:** wait for the Video chat (#2149), add a Video chat type here, or let a Photo chat make clips when its model is a video model.

## Decision

Option 2, animated WebP, and clips in a Photo chat for now. Talking to the process directly avoids teaching the router job state for one caller; WebP works with every sd-server build and needs no new player; and a Photo chat with a video model makes the feature usable now without duplicating #2149, whose Video chat can use the same turn when it lands.

## Consequences

- External clients of the engine's port cannot make clips through it; they would need option 1.
- A clip's job is tied to its process: if sd-server dies or the model is unloaded mid-job, the turn ends with "The video model stopped while making the clip" rather than waiting.
- Animated WebP is larger than WebM and has no player controls; revisit when the Video chat lands or if clips grow longer than a few seconds.
- When #2149 lands, video models move to the Video chat and this record is superseded for the "where" part.
