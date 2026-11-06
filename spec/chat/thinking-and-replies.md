---
title: "Thinking and replies"
area: chat
---

# Thinking and replies

User intent: in a long agent turn, tell the agent thinking apart from the agent talking to you. Reasoning, progress notes and the closing reply used to read the same, so the reply was easy to skim past, and a question or a step left for the person got lost further up the turn ([#1574](https://github.com/nekko-labs/nekko-agent/issues/1574)).

## How a block reads

- `[implemented; focused tests and hidden desktop captures at 1500px and 700px]` **Thinking is quiet.** Reasoning and progress notes between steps use the soft ink colour with the thought icon on their left, in the transcript's gutter.
- `[implemented; 56 focused tests, desktop typecheck and hidden Electron computed-style/geometry comparisons passed; before/after PNGs captured, pixel inspection blocked by image-tool errors]` **The reply stands out without a card.** In desktop and the shared Local Web UI, the closing summary/reply after tool calls uses only a straight accent-colored left border, with no tinted background, surrounding border, or rounded corners. Its spacing, text alignment, topic headers and message actions stay unchanged; mid-turn attention panels keep their existing treatment. A reply with no steps before it has nothing to stand out from, so ordinary conversation stays plain prose. This is display-only: stored messages, model calls and privacy boundaries do not change. Native iOS and Android retain their existing panels.
- `[implemented; focused tests and hidden desktop captures]` **What is left for you stands out wherever it is.** A mid-turn message that names a topic, or that stops on a question, sits on an attention panel instead of reading as a note. A note that only asks itself something in passing stays quiet.
- `[implemented; focused tests and hidden desktop captures]` **A note is not the end of anything.** Notes between steps no longer say Done, and no longer repeat the reasoning their step already shows.
- `[implemented; column positions measured in the hidden captures, voice settling covered by focused tests]` **Text does not move.** While a turn runs, its newest text has no voice yet, because it may be a note or the reply. It settles when more follows it or the turn ends. The icon and the panel live in the gutter, so settling changes the look without re-wrapping the text.
- `[implemented; panel and message edges measured in hidden captures at 1500px and 700px; not yet checked in the packaged app]` **Panels stop where your messages stop.** A panel's right edge lines up with your own messages, so it keeps the same space from the swipe-left times. All agent text stops 14px short of that edge, so a panel has room for its padding and a block that settles does not re-wrap.

## Topic headers

- `[implemented; focused tests and hidden desktop captures]` A line of its own that names a topic, as a Markdown heading or a bold label, is drawn as a header with an icon: questions, next steps and actions, commands to run, decisions and assumptions, and summaries (Summary, Changes, Verified, Not verified / blocked). Words after the label become the section's first line. The icon carries the colour, and only what asks something of the reader is loud.
- `[implemented; focused tests and hidden desktop captures]` A settled message that closes on a question with no label gets a Question header. It only applies to replies and mid-turn messages, not to ordinary conversation, where ending on a question is just how people talk.
- `[implemented; golden fixtures, not checked against live models]` The system prompt asks every model to use these labels in any message of a turn, and to end a message with its question.

Topics are read from the text the model wrote, with no model call and no change to what is stored. Copy and Find in this chat keep working on the original text. Only agent text is read this way: your own messages and reasoning render as before.

## On the phones

- `[implemented; Kotlin and Swift unit tests with the desktop's cases, emulator and simulator captures of a fixture turn]` The iOS and Android transcripts draw the same three voices and topic headers ([#1580](https://github.com/nekko-labs/nekko-agent/issues/1580), TASKS VOICE-3). The thought icon and the panels' edges sit in the transcript's 16pt side padding, so a block that settles its voice does not re-wrap. A phone puts the closing question's header over the question's own paragraph rather than over the whole closing run of text.

## Limits

- Labels are recognised in English. A reply in another language gets its panels and the closing question header (`？` counts), but a translated label stays bold text.
- A model that ignores the labels still gets the panels and the closing question header, not the other headers.
