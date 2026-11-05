---
title: "Persistent PR lifecycle cards in agent chat"
area: chat
---

# Persistent PR lifecycle cards in agent chat

## Intent

Retain confirmed PR lifecycle interactions in their original chat position, while distinguishing historical milestones from subsequently fetched live status. Tracking: #1812.

## Implemented: shared provenance model

`PrEvent`, `isPrInteractionCall` and `collectSessionPrInteractions` parse attributable successful bash/Bash calls to gh PR commands. Events distinguish creation, draft creation, draft, ready, auto-merge enabled, queue entry, merge request, actual merge, close, reopen, update, review and view. Canonical URL, explicit repo/number, gh status identity or a unique already-known identity supplies the PR link. Failed/pending/orphan/replayed results, ambiguous shell batches, scripts, arbitrary prose and quoted body/title URLs do not certify events. Silent merge success remains merge-requested; explicit auto-merge and queue confirmations are separate from merged. No-op/already-state responses, contradictory transitions, multiple confirmations and unknown merge output do not invent new lifecycle transitions. Branch selectors require gh’s identifying confirmation. The reconciled parser incorporates #1816’s confirmation and regression cases without a second projection API. Existing create heredocs, one leading cd and output trims remain supported. Focused parser tests cover identity, command provenance, success/failure and chronology.

This layer adds the projection API without changing the existing creation-only session collector or renderer. No visual change.

## Planned in the dependent renderer layer

Use events in saved and streaming transcripts, preserve stable repeated milestones through the held/saved handoff, retain one live action/status card, and add responsive visual evidence and user-facing docs. Desktop/narrow pixel inspection, live handoff integration and packaged/native-device verification are not claims of this model-only layer.
