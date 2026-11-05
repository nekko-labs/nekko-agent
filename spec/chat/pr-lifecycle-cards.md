---
title: "Persistent PR lifecycle cards in agent chat"
area: chat
---

# Persistent PR lifecycle cards in agent chat

## Intent

Retain confirmed PR lifecycle interactions in their original chat position, while distinguishing historical milestones from subsequently fetched live status. Tracking: #1812.

## Implemented: shared provenance model

`PrEvent`, `isPrInteractionCall` and `collectSessionPrInteractions` parse attributable successful bash/Bash calls to gh PR commands. Events distinguish creation, draft, ready, queue entry, merge request, actual merge, close, reopen, update, review and view. Canonical URL, explicit repo/number, gh status identity or a unique already-known identity supplies the PR link. Failed/pending/orphan/replayed results, ambiguous shell batches, scripts, arbitrary prose and quoted body/title URLs do not certify events. Auto-merge requested is not merged. Existing create heredocs, one leading cd and output trims remain supported. Focused parser tests cover identity, command provenance, success/failure and chronology.

This layer adds the projection API without changing the existing creation-only session collector or renderer. No visual change.

## Planned in the dependent renderer layer

Use events in saved and streaming transcripts, preserve stable repeated milestones through the held/saved handoff, retain one live action/status card, and add responsive visual evidence and user-facing docs. Desktop/narrow pixel inspection, live handoff integration and packaged/native-device verification are not claims of this model-only layer.
